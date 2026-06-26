import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { newScanId, scanLog } from '../../shared/scanLog'

type Mode = 'standby' | 'active'
type Phase = 'scanning' | 'analyzing' | 'success' | 'error'

// Sampling / stabilization tuning.
const SAMPLE_W = 80
const SAMPLE_H = 60
const SAMPLE_INTERVAL_MS = 200
const STILL_THRESHOLD = 6
const MOTION_THRESHOLD = 14
const STABLE_FRAMES_NEEDED = 4
const WARMUP_MS = 400
const HINTS_AFTER_MS = 2600
const GIVE_UP_MS = 12000
const LOW_LIGHT = 55
const COLLAPSE_MS = 240

const isPackaged = !import.meta.env.DEV

const CameraIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path
      d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.2l.7-1.2A1.5 1.5 0 0 1 8.7 4h6.6a1.5 1.5 0 0 1 1.3.8L17.3 6h1.2A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-8Z"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <circle cx="12" cy="12.5" r="3.2" stroke="currentColor" strokeWidth="1.6" />
  </svg>
)

const CheckIcon = (): JSX.Element => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden>
    <path
      d="M5 12.5l4.2 4.2L19 7"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

function OverlayApp(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)

  const prevGrayRef = useRef<Uint8ClampedArray | null>(null)
  const stableCountRef = useRef(0)
  const busyRef = useRef(false)
  const doneRef = useRef(false)
  /** True while a scan session is active (hotkey → standby). */
  const isScanningRef = useRef(false)
  const mountedRef = useRef(true)
  /** Locked after the first successful capture+insert for this session. */
  const hasCapturedThisSessionRef = useRef(false)
  /** True while an AI runScan call is in flight for this session. */
  const analysisInFlightRef = useRef(false)

  const currentScanSessionIdRef = useRef('')
  const sessionGenRef = useRef(0)
  const startCameraGenRef = useRef(0)

  const lastMotionRef = useRef(0)
  const showHintsRef = useRef(false)
  const lastCoachRef = useRef('')

  const loopRef = useRef<number | null>(null)
  const intervalIdsRef = useRef<Set<number>>(new Set())
  const warmupTimerRef = useRef<number | null>(null)
  const hintTimerRef = useRef<number | null>(null)
  const failTimerRef = useRef<number | null>(null)

  const [mode, setMode] = useState<Mode>('standby')
  const [phase, setPhase] = useState<Phase>('scanning')
  const [coachText, setCoachText] = useState('')
  const [successLabel, setSuccessLabel] = useState('')
  const [errorText, setErrorText] = useState('')
  const [collapsing, setCollapsing] = useState(false)
  const [hover, setHover] = useState(false)

  const log = useCallback((phase: string, extra: Record<string, unknown> = {}) => {
    scanLog(phase, {
      scanId: currentScanSessionIdRef.current,
      sessionGen: sessionGenRef.current,
      packaged: isPackaged,
      ...extra
    })
  }, [])

  const isActiveSession = useCallback((sessionGen: number): boolean => {
    return mountedRef.current && sessionGen === sessionGenRef.current
  }, [])

  const stopCamera = useCallback(() => {
    const stream = streamRef.current
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const pauseSampleLoop = useCallback(() => {
    for (const id of intervalIdsRef.current) clearInterval(id)
    intervalIdsRef.current.clear()
    if (loopRef.current !== null) clearInterval(loopRef.current)
    loopRef.current = null
  }, [])

  const stopAllCapture = useCallback(() => {
    pauseSampleLoop()
    if (warmupTimerRef.current !== null) clearTimeout(warmupTimerRef.current)
    if (hintTimerRef.current !== null) clearTimeout(hintTimerRef.current)
    if (failTimerRef.current !== null) clearTimeout(failTimerRef.current)
    warmupTimerRef.current = null
    hintTimerRef.current = null
    failTimerRef.current = null
    stopCamera()
  }, [pauseSampleLoop, stopCamera])

  const resumeSampleLoop = useCallback(
    (sessionGen: number) => {
      if (!isActiveSession(sessionGen)) return
      if (
        hasCapturedThisSessionRef.current ||
        doneRef.current ||
        analysisInFlightRef.current ||
        busyRef.current
      ) {
        return
      }
      if (loopRef.current !== null) return
      const id = window.setInterval(() => sampleRef.current(sessionGen), SAMPLE_INTERVAL_MS)
      intervalIdsRef.current.add(id)
      loopRef.current = id
    },
    [isActiveSession]
  )

  const returnToStandby = useCallback((delayMs: number) => {
    window.setTimeout(() => {
      if (!mountedRef.current) return
      setCollapsing(true)
      window.setTimeout(() => {
        if (!mountedRef.current) return
        isScanningRef.current = false
        setMode('standby')
        setCollapsing(false)
        setPhase('scanning')
        setCoachText('')
        setSuccessLabel('')
        setErrorText('')
        setHover(false)
        busyRef.current = false
        hasCapturedThisSessionRef.current = false
        analysisInFlightRef.current = false
        void window.api.setMouseIgnore(true)
        void window.api.scanSessionEnded(currentScanSessionIdRef.current)
      }, COLLAPSE_MS)
    }, delayMs)
  }, [])

  const captureFullFrame = useCallback((): string | null => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) return null
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  }, [])

  const finishWithError = useCallback(
    (message: string, delayMs: number, sessionGen: number) => {
      if (!isActiveSession(sessionGen)) return
      doneRef.current = true
      stopAllCapture()
      setPhase('error')
      setErrorText(message)
      returnToStandby(delayMs)
    },
    [isActiveSession, returnToStandby, stopAllCapture]
  )

  const finishWithSuccess = useCallback(
    (label: string, sessionGen: number) => {
      if (!isActiveSession(sessionGen) || doneRef.current) return
      hasCapturedThisSessionRef.current = true
      doneRef.current = true
      stopAllCapture()
      setSuccessLabel(label)
      setPhase('success')
      log('scan-session-success-locked')
      returnToStandby(150)
    },
    [isActiveSession, log, returnToStandby, stopAllCapture]
  )

  const updateCoach = useCallback((brightness: number) => {
    if (!showHintsRef.current) return
    let hint: string
    if (brightness < LOW_LIGHT) hint = 'Need more light'
    else if (Date.now() - lastMotionRef.current < 500) hint = 'Hold steady'
    else hint = Math.floor(Date.now() / 2200) % 2 === 0 ? 'Center the object' : 'Move it closer'
    if (hint !== lastCoachRef.current) {
      lastCoachRef.current = hint
      setCoachText(hint)
    }
  }, [])

  const tryAnalyzeFrame = useCallback(
    async (sessionGen: number) => {
      if (!isActiveSession(sessionGen)) {
        log('scan-ignored-stale-session', { sessionGen })
        return
      }
      if (
        busyRef.current ||
        doneRef.current ||
        hasCapturedThisSessionRef.current ||
        analysisInFlightRef.current
      ) {
        log('scan-ignored-locked', {
          busy: busyRef.current,
          done: doneRef.current,
          hasCaptured: hasCapturedThisSessionRef.current,
          analysisInFlight: analysisInFlightRef.current,
          duplicate: true
        })
        return
      }

      busyRef.current = true
      analysisInFlightRef.current = true
      stableCountRef.current = 0
      pauseSampleLoop()
      setSuccessLabel('')
      setPhase('analyzing')

      const dataUrl = captureFullFrame()
      if (!dataUrl) {
        log('capture-failed')
        analysisInFlightRef.current = false
        busyRef.current = false
        resumeSampleLoop(sessionGen)
        return
      }

      const scanId = currentScanSessionIdRef.current
      log('capture', { bytes: dataUrl.length })
      log('run-scan-send')

      const result = await window.api.runScan({ scanId, dataUrl })

      analysisInFlightRef.current = false
      busyRef.current = false

      if (!isActiveSession(sessionGen)) {
        log('run-scan-result-ignored-stale-session', { duplicate: result.duplicate })
        return
      }

      if (hasCapturedThisSessionRef.current) {
        log('run-scan-result-ignored-after-success', { duplicate: true })
        return
      }

      log('run-scan-result', {
        ok: result.ok,
        found: result.found,
        duplicate: result.duplicate,
        retryable: result.retryable,
        label: result.label,
        insertLabel: result.insertLabel,
        inserted: result.inserted,
        error: result.error
      })

      if (result.ok && result.found) {
        finishWithSuccess(result.insertLabel || result.label, sessionGen)
        return
      }

      if (result.duplicate) {
        doneRef.current = true
        hasCapturedThisSessionRef.current = true
        stopAllCapture()
        returnToStandby(150)
        return
      }

      if (result.error) {
        log('scan-error', { error: result.error })
        finishWithError('Scan failed', 1400, sessionGen)
        return
      }

      if (!result.found) {
        if (result.retryable) {
          log('scan-not-found-retry')
          prevGrayRef.current = null
          stableCountRef.current = 0
          setSuccessLabel('')
          setPhase('scanning')
          resumeSampleLoop(sessionGen)
          return
        }
        log('scan-not-found')
        finishWithError("Couldn't identify object", 1400, sessionGen)
        return
      }
    },
    [
      captureFullFrame,
      finishWithError,
      finishWithSuccess,
      isActiveSession,
      log,
      pauseSampleLoop,
      resumeSampleLoop,
      returnToStandby,
      stopAllCapture
    ]
  )

  const sampleRef = useRef<(sessionGen: number) => void>(() => undefined)

  const sample = useCallback(
    (sessionGen: number) => {
      if (!isActiveSession(sessionGen)) return
      if (
        busyRef.current ||
        doneRef.current ||
        hasCapturedThisSessionRef.current ||
        analysisInFlightRef.current
      ) {
        return
      }

      const video = videoRef.current
      const canvas = sampleCanvasRef.current
      if (!video || !canvas || video.videoWidth === 0) return

      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return
      ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H)
      const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H)

      const gray = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H)
      let brightnessSum = 0
      for (let i = 0, j = 0; i < data.length; i += 4, j++) {
        const g = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
        gray[j] = g
        brightnessSum += g
      }
      const brightness = brightnessSum / gray.length

      const prev = prevGrayRef.current
      prevGrayRef.current = gray
      if (!prev) return

      let sum = 0
      for (let k = 0; k < gray.length; k++) sum += Math.abs(gray[k] - prev[k])
      const meanDiff = sum / gray.length

      if (meanDiff > MOTION_THRESHOLD) {
        lastMotionRef.current = Date.now()
        stableCountRef.current = 0
        updateCoach(brightness)
        return
      }

      updateCoach(brightness)

      if (meanDiff < STILL_THRESHOLD) stableCountRef.current += 1
      else stableCountRef.current = 0

      if (stableCountRef.current >= STABLE_FRAMES_NEEDED) {
        stableCountRef.current = 0
        void tryAnalyzeFrame(sessionGen)
      }
    },
    [isActiveSession, tryAnalyzeFrame, updateCoach]
  )

  sampleRef.current = sample

  const startCamera = useCallback(
    async (sessionGen: number, cameraGen: number) => {
      stopAllCapture()

      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API unavailable')
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })

        if (
          !isActiveSession(sessionGen) ||
          doneRef.current ||
          hasCapturedThisSessionRef.current ||
          cameraGen !== startCameraGenRef.current
        ) {
          stream.getTracks().forEach((t) => t.stop())
          log('camera-stale-session-discarded', { sessionGen, cameraGen })
          return
        }

        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play().catch(() => undefined)
        }

        if (cameraGen !== startCameraGenRef.current || !isActiveSession(sessionGen)) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        warmupTimerRef.current = window.setTimeout(() => {
          if (
            !isActiveSession(sessionGen) ||
            doneRef.current ||
            hasCapturedThisSessionRef.current ||
            analysisInFlightRef.current ||
            cameraGen !== startCameraGenRef.current
          ) {
            return
          }
          const id = window.setInterval(() => sample(sessionGen), SAMPLE_INTERVAL_MS)
          intervalIdsRef.current.add(id)
          loopRef.current = id
        }, WARMUP_MS)

        hintTimerRef.current = window.setTimeout(() => {
          if (!isActiveSession(sessionGen)) return
          showHintsRef.current = true
        }, HINTS_AFTER_MS)

        failTimerRef.current = window.setTimeout(() => {
          if (
            doneRef.current ||
            hasCapturedThisSessionRef.current ||
            analysisInFlightRef.current ||
            !isActiveSession(sessionGen)
          ) {
            return
          }
          log('scan-timeout')
          finishWithError("Couldn't capture", 1300, sessionGen)
        }, GIVE_UP_MS)
      } catch (err) {
        if (!isActiveSession(sessionGen)) return
        const message = err instanceof Error ? err.message : 'Camera unavailable'
        log('camera-error', { error: message })
        finishWithError(message.length > 40 ? 'Camera unavailable' : message, 1500, sessionGen)
      }
    },
    [finishWithError, isActiveSession, log, sample, stopAllCapture]
  )

  const activate = useCallback(async () => {
    if (isScanningRef.current) {
      log('activate-ignored-scan-in-progress', { duplicate: true })
      return
    }

    sessionGenRef.current += 1
    startCameraGenRef.current += 1
    const sessionGen = sessionGenRef.current
    const cameraGen = startCameraGenRef.current
    currentScanSessionIdRef.current = newScanId()

    isScanningRef.current = true
    doneRef.current = false
    busyRef.current = false
    hasCapturedThisSessionRef.current = false
    analysisInFlightRef.current = false
    stableCountRef.current = 0
    prevGrayRef.current = null
    showHintsRef.current = false
    lastCoachRef.current = ''

    setCoachText('')
    setSuccessLabel('')
    setErrorText('')
    setCollapsing(false)
    setHover(false)
    void window.api.setMouseIgnore(true)
    setPhase('scanning')
    setMode('active')

    log('scan-start', { sessionGen, trigger: 'overlay-toggle' })

    const session = await window.api.scanSessionStarted(currentScanSessionIdRef.current)
    if (!session.ok) {
      log('scan-session-rejected', { duplicate: session.duplicate })
      isScanningRef.current = false
      setMode('standby')
      void window.api.scanSessionEnded(currentScanSessionIdRef.current)
      return
    }

    void startCamera(sessionGen, cameraGen)
  }, [log, startCamera])

  const activateRef = useRef(activate)
  activateRef.current = activate

  useEffect(() => {
    mountedRef.current = true
    const offToggle = window.api.onOverlayToggle(() => {
      if (isScanningRef.current) {
        log('toggle-ignored-scan-in-progress', { duplicate: true })
        return
      }
      activateRef.current()
    })
    const onBeforeUnload = (): void => stopAllCapture()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      mountedRef.current = false
      sessionGenRef.current += 1
      offToggle()
      window.removeEventListener('beforeunload', onBeforeUnload)
      stopAllCapture()
    }
  }, [log, stopAllCapture])

  const onStandbyEnter = (): void => {
    setHover(true)
    void window.api.setMouseIgnore(false)
  }
  const onStandbyLeave = (): void => {
    setHover(false)
    void window.api.setMouseIgnore(true)
  }
  const onStandbyClick = (): void => {
    void window.api.openMainWindow()
  }

  if (mode === 'standby') {
    return (
      <div className="pill-wrap">
        <div
          className="standby-hit"
          onMouseEnter={onStandbyEnter}
          onMouseLeave={onStandbyLeave}
          onClick={onStandbyClick}
        >
          <div className={`pill standby${hover ? ' hover' : ''}${collapsing ? ' collapsing' : ''}`}>
            {hover && (
              <span className="pill-content">
                <span className="pill-icon">
                  <CameraIcon />
                </span>
                <span className="pill-text">Open Workbench Vision</span>
              </span>
            )}
          </div>
        </div>
        <video ref={videoRef} className="hidden-media" autoPlay muted playsInline />
        <canvas ref={sampleCanvasRef} width={SAMPLE_W} height={SAMPLE_H} className="hidden-media" />
      </div>
    )
  }

  let icon: JSX.Element
  if (phase === 'success') icon = <CheckIcon />
  else if (phase === 'analyzing') icon = <span className="pill-spinner" />
  else icon = <CameraIcon />

  let text = ''
  if (phase === 'success') text = successLabel
  else if (phase === 'error') text = errorText
  else if (phase === 'scanning') text = coachText

  return (
    <div className="pill-wrap">
      <div className={`pill ${phase}${collapsing ? ' collapsing' : ''}`}>
        <span className="pill-content">
          <span className="pill-icon">{icon}</span>
          {text && <span className="pill-text">{text}</span>}
        </span>
      </div>
      <video ref={videoRef} className="hidden-media" autoPlay muted playsInline />
      <canvas ref={sampleCanvasRef} width={SAMPLE_W} height={SAMPLE_H} className="hidden-media" />
    </div>
  )
}

export default OverlayApp

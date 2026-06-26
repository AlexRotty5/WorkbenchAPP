import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

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
  const requireMotionRef = useRef(false)
  const busyRef = useRef(false)
  const doneRef = useRef(false)
  const activeRef = useRef(false)
  const mountedRef = useRef(true)

  const lastMotionRef = useRef(0)
  const showHintsRef = useRef(false)
  const lastCoachRef = useRef('')

  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [mode, setMode] = useState<Mode>('standby')
  const [phase, setPhase] = useState<Phase>('scanning')
  const [coachText, setCoachText] = useState('')
  const [successLabel, setSuccessLabel] = useState('')
  const [errorText, setErrorText] = useState('')
  const [collapsing, setCollapsing] = useState(false)
  const [hover, setHover] = useState(false)

  const stopCamera = useCallback(() => {
    const stream = streamRef.current
    if (stream) {
      stream.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const clearTimers = useCallback(() => {
    if (loopRef.current) clearInterval(loopRef.current)
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current)
    if (failTimerRef.current) clearTimeout(failTimerRef.current)
    loopRef.current = null
    hintTimerRef.current = null
    failTimerRef.current = null
  }, [])

  // Collapse the active pill back into the standby pill (no window teardown).
  const returnToStandby = useCallback((delayMs: number) => {
    window.setTimeout(() => {
      if (!mountedRef.current) return
      setCollapsing(true)
      window.setTimeout(() => {
        if (!mountedRef.current) return
        activeRef.current = false
        setMode('standby')
        setCollapsing(false)
        setPhase('scanning')
        setCoachText('')
        setSuccessLabel('')
        setErrorText('')
        setHover(false)
        void window.api.setMouseIgnore(true)
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

  const runDetection = useCallback(async () => {
    if (busyRef.current || doneRef.current) return
    busyRef.current = true
    setPhase('analyzing')

    const dataUrl = captureFullFrame()
    if (!dataUrl) {
      busyRef.current = false
      setPhase('scanning')
      return
    }

    const result = await window.api.detectObject(dataUrl)
    if (!mountedRef.current || doneRef.current) return

    if (result.error) {
      doneRef.current = true
      clearTimers()
      stopCamera()
      setPhase('error')
      setErrorText('Scan failed')
      returnToStandby(1400)
      return
    }

    if (!result.found) {
      requireMotionRef.current = true
      stableCountRef.current = 0
      prevGrayRef.current = null
      busyRef.current = false
      setPhase('scanning')
      return
    }

    // Found — finalize, insert, and settle back to standby.
    doneRef.current = true
    clearTimers()
    stopCamera()
    setSuccessLabel(result.label)
    setPhase('success')

    await window.api.completeScan({ imageDataUrl: dataUrl, label: result.label })
    if (!mountedRef.current) return
    returnToStandby(300)
  }, [captureFullFrame, clearTimers, returnToStandby, stopCamera])

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

  const sample = useCallback(() => {
    if (busyRef.current || doneRef.current) return
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
      requireMotionRef.current = false
      stableCountRef.current = 0
      updateCoach(brightness)
      return
    }

    updateCoach(brightness)
    if (requireMotionRef.current) return

    if (meanDiff < STILL_THRESHOLD) stableCountRef.current += 1
    else stableCountRef.current = 0

    if (stableCountRef.current >= STABLE_FRAMES_NEEDED) void runDetection()
  }, [runDetection, updateCoach])

  const startCamera = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API unavailable')
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (doneRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play().catch(() => undefined)
      }

      window.setTimeout(() => {
        if (!mountedRef.current || doneRef.current) return
        loopRef.current = setInterval(() => sample(), SAMPLE_INTERVAL_MS)
      }, WARMUP_MS)

      hintTimerRef.current = setTimeout(() => {
        showHintsRef.current = true
      }, HINTS_AFTER_MS)

      failTimerRef.current = setTimeout(() => {
        if (doneRef.current || !mountedRef.current) return
        doneRef.current = true
        clearTimers()
        stopCamera()
        setPhase('error')
        setErrorText("Couldn't capture")
        returnToStandby(1300)
      }, GIVE_UP_MS)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Camera unavailable'
      doneRef.current = true
      clearTimers()
      setPhase('error')
      setErrorText(message.length > 40 ? 'Camera unavailable' : message)
      returnToStandby(1500)
    }
  }, [clearTimers, returnToStandby, sample, stopCamera])

  const activate = useCallback(() => {
    if (activeRef.current) return
    activeRef.current = true
    doneRef.current = false
    busyRef.current = false
    requireMotionRef.current = false
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
    void startCamera()
  }, [startCamera])

  const cancelActive = useCallback(() => {
    if (!activeRef.current) return
    doneRef.current = true
    clearTimers()
    stopCamera()
    returnToStandby(0)
  }, [clearTimers, returnToStandby, stopCamera])

  useEffect(() => {
    mountedRef.current = true
    const offToggle = window.api.onOverlayToggle(() => {
      if (activeRef.current) cancelActive()
      else activate()
    })
    const onBeforeUnload = (): void => stopCamera()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      mountedRef.current = false
      offToggle()
      window.removeEventListener('beforeunload', onBeforeUnload)
      clearTimers()
      stopCamera()
    }
  }, [activate, cancelActive, clearTimers, stopCamera])

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

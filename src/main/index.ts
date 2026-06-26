import { join } from 'path'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { config as loadEnv } from 'dotenv'
import {
  app,
  shell,
  screen,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  globalShortcut,
  systemPreferences,
  session,
  clipboard,
  nativeImage
} from 'electron'
import type { NativeImage } from 'electron'
import { detectObject } from './openai'
import { IPC } from '../shared/types'
import type {
  DetectObjectPayload,
  DetectResult,
  InsertResult,
  RunScanPayload,
  RunScanResult,
  ScanCompletePayload,
  ScanRecord
} from '../shared/types'
import { scanLog } from '../shared/scanLog'

// Load OPENAI_API_KEY in the MAIN process only.
// In dev this comes from the project-root .env (cwd). A packaged app launched
// from /Applications has no project root, so we also read a stable per-user
// config file at ~/Library/Application Support/Workbench Vision/.env.
loadEnv()

function loadUserEnv(): void {
  try {
    const userEnv = join(app.getPath('userData'), '.env')
    if (existsSync(userEnv)) {
      loadEnv({ path: userEnv })
    }
  } catch {
    // best-effort; getClient() will surface a friendly message if the key is missing
  }
}

const execFileAsync = promisify(execFile)
const isDev = !app.isPackaged
const HOTKEY = 'Control+Alt+Space'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const TOGGLE_DEBOUNCE_MS = 800
const SCAN_COOLDOWN_MS = 8000
const IMAGE_DEDUPE_MS = 60000
const INSERT_COOLDOWN_MS = 8000
const MAX_PROCESSED_SCANS = 200

let lastOverlayToggleAt = 0
let scanCooldownUntil = 0
let overlayScanActive = false
let activeOverlaySessionScanId: string | null = null
/** Scan ID that already produced the one allowed card+insert for this hotkey session. */
let sessionCommittedScanId: string | null = null
let lastGlobalInsertAt = 0
let accessibilityVerifiedByInsert = false
let lastSuccessfulInsertAt = 0
let ipcRegistered = false
let shortcutRegistered = false

/** Scan IDs that already created a card and/or attempted auto-insert. */
const processedScanIds = new Set<string>()

/** Coalesce duplicate in-flight AI requests for the same scan ID. */
const detectInflight = new Map<string, Promise<DetectResult>>()

/** Coalesce duplicate in-flight atomic scan pipelines for the same scan ID. */
const runScanInflight = new Map<string, Promise<RunScanResult>>()

/** Global lock: only one scan pipeline at a time across the app. */
let activeRunScanId: string | null = null

/** Scan IDs that already had text/image inserted into the active field. */
const insertedScanIds = new Set<string>()

/** Image fingerprints that already had a label inserted. */
const insertedImageFingerprints = new Set<string>()

/** Serialize all auto-insert operations (prevents overlapping pastes). */
let insertQueue: Promise<void> = Promise.resolve()

/** Fingerprints of images that already produced a card or insert recently. */
const recentImageFingerprints = new Map<string, number>()

function fingerprintImage(dataUrl: string): string {
  const buffer = dataUrlToBuffer(dataUrl)
  if (!buffer || buffer.length < 64) {
    return createHash('sha256').update(dataUrl.slice(0, 2000)).digest('hex').slice(0, 16)
  }
  // Fuzzy hash: similar frames (user adjusting distance) map to the same fingerprint.
  const lenBucket = Math.floor(buffer.length / 4096)
  const step = Math.max(1, Math.floor(buffer.length / 48))
  const samples: number[] = [lenBucket]
  for (let i = 0; i < buffer.length; i += step) {
    samples.push(buffer[i])
  }
  return createHash('sha256').update(Buffer.from(samples)).digest('hex').slice(0, 16)
}

function isDuplicateImage(dataUrl: string): boolean {
  const fp = fingerprintImage(dataUrl)
  const seenAt = recentImageFingerprints.get(fp)
  if (seenAt && Date.now() - seenAt < IMAGE_DEDUPE_MS) return true
  return false
}

function markImageSeen(dataUrl: string): void {
  recentImageFingerprints.set(fingerprintImage(dataUrl), Date.now())
  if (recentImageFingerprints.size > MAX_PROCESSED_SCANS) {
    const oldest = recentImageFingerprints.keys().next().value
    if (oldest) recentImageFingerprints.delete(oldest)
  }
}

function beginScanCooldown(): void {
  scanCooldownUntil = Date.now() + SCAN_COOLDOWN_MS
  overlayScanActive = false
  activeOverlaySessionScanId = null
  // Keep sessionCommittedScanId until a new hotkey session starts so late AI results
  // cannot create a second registry card after the session UI has already closed.
}

function resetScanSessionState(scanId: string): void {
  activeOverlaySessionScanId = scanId
  overlayScanActive = true
  sessionCommittedScanId = null
}

function sessionAlreadyCommitted(scanId: string): boolean {
  if (sessionCommittedScanId === scanId) return true
  const disk = readDiskScanLock()
  return disk.committedScanId === scanId
}

/* Cross-process scan lock (dev + packaged app share the same userData folder). */
interface DiskScanLock {
  activeScanId: string | null
  activeStartedAt: number
  committedScanId: string | null
  committedAt: number
  lastInsertAt: number
}

function emptyDiskScanLock(): DiskScanLock {
  return {
    activeScanId: null,
    activeStartedAt: 0,
    committedScanId: null,
    committedAt: 0,
    lastInsertAt: 0
  }
}

function scanLockPath(): string {
  return join(app.getPath('userData'), 'scan-lock.json')
}

function readDiskScanLock(): DiskScanLock {
  try {
    const parsed = JSON.parse(readFileSync(scanLockPath(), 'utf-8')) as Partial<DiskScanLock>
    return {
      activeScanId: parsed.activeScanId ?? null,
      activeStartedAt: parsed.activeStartedAt ?? 0,
      committedScanId: parsed.committedScanId ?? null,
      committedAt: parsed.committedAt ?? 0,
      lastInsertAt: parsed.lastInsertAt ?? 0
    }
  } catch {
    return emptyDiskScanLock()
  }
}

function writeDiskScanLock(state: DiskScanLock): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(scanLockPath(), JSON.stringify(state), 'utf-8')
  } catch {
    /* best-effort */
  }
}

function diskSessionStart(scanId: string): boolean {
  const now = Date.now()
  const disk = readDiskScanLock()
  if (disk.committedScanId === scanId) return false
  if (
    disk.activeScanId &&
    disk.activeScanId !== scanId &&
    now - disk.activeStartedAt < 60000
  ) {
    return false
  }
  writeDiskScanLock({ ...disk, activeScanId: scanId, activeStartedAt: now })
  return true
}

function diskSessionCommit(scanId: string): boolean {
  const disk = readDiskScanLock()
  if (disk.committedScanId === scanId) return false
  writeDiskScanLock({
    ...disk,
    committedScanId: scanId,
    committedAt: Date.now(),
    activeScanId: null
  })
  return true
}

function diskSessionEnd(scanId?: string): void {
  const disk = readDiskScanLock()
  if (!scanId || disk.activeScanId === scanId) {
    writeDiskScanLock({ ...disk, activeScanId: null })
  }
}

function diskCanInsert(): boolean {
  return Date.now() - readDiskScanLock().lastInsertAt >= INSERT_COOLDOWN_MS
}

function diskMarkInserted(): void {
  const disk = readDiskScanLock()
  writeDiskScanLock({ ...disk, lastInsertAt: Date.now() })
}

function getAccessibilityStatus(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    if (systemPreferences.isTrustedAccessibilityClient(false)) return true
  } catch {
    /* fall through */
  }
  // macOS sometimes reports false even when paste works; trust a recent successful insert.
  if (accessibilityVerifiedByInsert && Date.now() - lastSuccessfulInsertAt < 7 * 86400000) {
    return true
  }
  return false
}

function notifyAccessibilityStatus(): void {
  mainWindow?.webContents.send(IPC.accessibilityUpdated, getAccessibilityStatus())
}

function markAccessibilityWorking(): void {
  accessibilityVerifiedByInsert = true
  lastSuccessfulInsertAt = Date.now()
  notifyAccessibilityStatus()
}

function canSendOverlayToggle(source: string): boolean {
  const now = Date.now()
  if (overlayScanActive) {
    logScan('overlay-toggle-blocked-active-session', 'system', { source })
    return false
  }
  if (now < scanCooldownUntil) {
    logScan('overlay-toggle-blocked-cooldown', 'system', {
      source,
      msRemaining: scanCooldownUntil - now
    })
    return false
  }
  if (activeRunScanId || runScanInflight.size > 0) {
    logScan('overlay-toggle-blocked-scan-in-flight', 'system', { source, activeRunScanId })
    return false
  }
  return true
}

function logScan(phase: string, scanId: string, extra: Record<string, unknown> = {}): void {
  scanLog(phase, { scanId, packaged: !isDev, ...extra })
}

function claimScanProcessing(scanId: string): boolean {
  if (!scanId || processedScanIds.has(scanId)) return false
  processedScanIds.add(scanId)
  if (processedScanIds.size > MAX_PROCESSED_SCANS) {
    const oldest = processedScanIds.values().next().value
    if (oldest) processedScanIds.delete(oldest)
  }
  return true
}

/* ------------------------------------------------------------------ */
/* Renderer loading                                                    */
/* ------------------------------------------------------------------ */

function rendererEntry(htmlFile: string): { url?: string; file?: string } {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServer) {
    return { url: `${devServer}/${htmlFile}` }
  }
  return { file: join(__dirname, `../renderer/${htmlFile}`) }
}

function loadRenderer(win: BrowserWindow, htmlFile: string): void {
  const entry = rendererEntry(htmlFile)
  if (entry.url) {
    void win.loadURL(entry.url)
  } else if (entry.file) {
    void win.loadFile(entry.file)
  }
}

/* ------------------------------------------------------------------ */
/* Scan registry (local persistence)                                   */
/* ------------------------------------------------------------------ */

const MAX_SCANS = 100

interface IndexEntry {
  id: string
  label: string
  timestamp: number
}

function imagesDir(): string {
  return join(app.getPath('userData'), 'scans')
}

function indexFile(): string {
  return join(app.getPath('userData'), 'scans.json')
}

function ensureStorage(): void {
  const dir = imagesDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function loadIndex(): IndexEntry[] {
  try {
    const raw = readFileSync(indexFile(), 'utf-8')
    const parsed = JSON.parse(raw) as IndexEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveIndex(entries: IndexEntry[]): void {
  try {
    writeFileSync(indexFile(), JSON.stringify(entries, null, 2), 'utf-8')
  } catch {
    // best-effort persistence
  }
}

function imagePath(id: string): string {
  return join(imagesDir(), `${id}.jpg`)
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const match = /^data:image\/\w+;base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  return Buffer.from(match[1], 'base64')
}

function addScan(payload: ScanCompletePayload): IndexEntry {
  ensureStorage()
  const entry: IndexEntry = {
    id: payload.scanId,
    label: payload.label,
    timestamp: Date.now()
  }
  const buffer = dataUrlToBuffer(payload.imageDataUrl)
  if (buffer) {
    try {
      writeFileSync(imagePath(entry.id), buffer)
    } catch {
      // ignore write failure; entry still recorded
    }
  }

  // Upsert: one registry card per scan session ID (never duplicate cards for retries).
  const entries = loadIndex().filter((e) => e.id !== payload.scanId)
  entries.unshift(entry)
  // Trim to the most recent MAX_SCANS, deleting overflow image files.
  const overflow = entries.slice(MAX_SCANS)
  for (const old of overflow) {
    try {
      rmSync(imagePath(old.id), { force: true })
    } catch {
      /* ignore */
    }
  }
  const trimmed = entries.slice(0, MAX_SCANS)
  saveIndex(trimmed)
  return entry
}

function readScanRecord(entry: IndexEntry): ScanRecord {
  let imageDataUrl = ''
  try {
    const buffer = readFileSync(imagePath(entry.id))
    imageDataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`
  } catch {
    /* image missing */
  }
  return { id: entry.id, label: entry.label, timestamp: entry.timestamp, imageDataUrl }
}

function getScans(): ScanRecord[] {
  return loadIndex().map(readScanRecord)
}

function deleteScan(id: string): void {
  const entries = loadIndex().filter((e) => e.id !== id)
  try {
    rmSync(imagePath(id), { force: true })
  } catch {
    /* ignore */
  }
  saveIndex(entries)
}

function clearScans(): void {
  try {
    for (const file of readdirSync(imagesDir())) {
      rmSync(join(imagesDir(), file), { force: true })
    }
  } catch {
    /* ignore */
  }
  saveIndex([])
}

function notifyScansUpdated(): void {
  mainWindow?.webContents.send(IPC.scansUpdated, getScans())
}

async function executeRunScan(payload: RunScanPayload): Promise<RunScanResult> {
  const { scanId, dataUrl } = payload
  const fail = (extra: Partial<RunScanResult> = {}): RunScanResult => ({
    ok: false,
    found: false,
    label: '',
    insertLabel: '',
    inserted: false,
    ...extra
  })

  if (!scanId || !dataUrl) {
    logScan('run-scan-rejected', scanId || 'unknown', { reason: 'invalid-payload' })
    return fail({ error: 'Invalid scan payload.' })
  }

  if (Date.now() < scanCooldownUntil && !overlayScanActive) {
    logScan('run-scan-blocked-cooldown', scanId, { duplicate: true })
    return fail({ duplicate: true, error: 'Scan cooldown active.' })
  }

  if (activeRunScanId && activeRunScanId !== scanId) {
    logScan('run-scan-rejected', scanId, { reason: 'other-scan-active', activeRunScanId })
    return fail({ duplicate: true, error: 'Another scan is already in progress.' })
  }

  if (activeOverlaySessionScanId && scanId !== activeOverlaySessionScanId) {
    logScan('run-scan-rejected', scanId, {
      reason: 'wrong-session',
      activeOverlaySessionScanId,
      duplicate: true
    })
    return fail({ duplicate: true, error: 'Scan ID does not match the active session.' })
  }

  if (sessionAlreadyCommitted(scanId)) {
    logScan('run-scan-rejected', scanId, { reason: 'session-already-committed', duplicate: true })
    return fail({ duplicate: true, error: 'This scan session already produced a result.' })
  }

  activeRunScanId = scanId

  try {
    logScan('ai-request', scanId)

    const detect = await detectObject(dataUrl)
    logScan('ai-response', scanId, {
      found: detect.found,
      label: detect.label,
      insertLabel: detect.insertLabel,
      error: detect.error
    })

    if (detect.error) {
      return fail({ error: detect.error })
    }

    if (!detect.found) {
      return {
        ok: false,
        found: false,
        label: '',
        insertLabel: '',
        inserted: false,
        retryable: true
      }
    }

    // Lock before card/insert so concurrent/late results from the same session are ignored.
    if (sessionAlreadyCommitted(scanId)) {
      logScan('run-scan-success-duplicate-ignored', scanId, { duplicate: true })
      return fail({ duplicate: true })
    }
    if (!diskSessionCommit(scanId)) {
      logScan('run-scan-disk-commit-blocked', scanId, { duplicate: true })
      return fail({ duplicate: true })
    }
    sessionCommittedScanId = scanId

    if (!claimScanProcessing(scanId)) {
      logScan('run-scan-duplicate-ignored', scanId, { duplicate: true })
      return fail({ duplicate: true })
    }

    if (isDuplicateImage(dataUrl)) {
      logScan('run-scan-duplicate-image-ignored', scanId, { duplicate: true })
      return fail({ duplicate: true, error: 'This image was already scanned recently.' })
    }

    markImageSeen(dataUrl)

    const completePayload: ScanCompletePayload = {
      scanId,
      imageDataUrl: dataUrl,
      label: detect.label,
      insertLabel: detect.insertLabel
    }

    logScan('card-create', scanId, {
      label: detect.label,
      insertLabel: detect.insertLabel
    })
    addScan(completePayload)
    notifyScansUpdated()

    logScan('auto-insert-start', scanId, { insertLabel: detect.insertLabel })
    const insertResult = await insertIntoActiveField(completePayload)
    if (insertResult.duplicate) {
      logScan('auto-insert-skipped-duplicate', scanId, { duplicate: true })
    } else if (insertResult.inserted) {
      markAccessibilityWorking()
    }

    return {
      ok: true,
      found: true,
      label: detect.label,
      insertLabel: detect.insertLabel,
      inserted: insertResult.inserted,
      error: insertResult.error
    }
  } finally {
    if (activeRunScanId === scanId) activeRunScanId = null
  }
}

/* ------------------------------------------------------------------ */
/* Inserting into the active text field of another app                 */
/* ------------------------------------------------------------------ */

function accessibilityTrusted(prompt = false): boolean {
  if (process.platform !== 'darwin') return true
  if (!prompt && getAccessibilityStatus()) return true
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt)
  } catch {
    return false
  }
}

async function pressCmdV(): Promise<void> {
  await execFileAsync('osascript', [
    '-e',
    'tell application "System Events" to keystroke "v" using command down'
  ])
}

interface ClipboardSnapshot {
  text: string
  image: NativeImage
}

function saveClipboardSnapshot(): ClipboardSnapshot {
  return { text: clipboard.readText(), image: clipboard.readImage() }
}

function restoreClipboardSnapshot(snapshot: ClipboardSnapshot): void {
  if (!snapshot.image.isEmpty()) {
    clipboard.write({ text: snapshot.text, image: snapshot.image })
  } else if (snapshot.text) {
    clipboard.writeText(snapshot.text)
  } else {
    clipboard.clear()
  }
}

/** Labels we can type directly without a second clipboard paste (avoids duplicate Cmd+V). */
function canTypeLabelDirectly(text: string): boolean {
  return text.length > 0 && text.length <= 60 && !/["\\]/.test(text)
}

async function typeLabelIntoField(labelText: string): Promise<void> {
  const escaped = labelText.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  await execFileAsync('osascript', [
    '-e',
    `tell application "System Events" to keystroke "${escaped}"`
  ])
}

async function performInsert(payload: ScanCompletePayload): Promise<InsertResult> {
  const { scanId, insertLabel: labelText } = payload
  const trusted = accessibilityTrusted(false)
  const base: InsertResult = {
    saved: true,
    inserted: false,
    accessibility: trusted,
    scanId
  }

  if (insertedScanIds.has(scanId)) {
    logScan('auto-insert-duplicate-ignored', scanId, { duplicate: true })
    return { ...base, duplicate: true }
  }

  const imageFp = fingerprintImage(payload.imageDataUrl)
  if (insertedImageFingerprints.has(imageFp)) {
    logScan('auto-insert-blocked-duplicate-image', scanId, { duplicate: true, imageFp })
    return { ...base, duplicate: true }
  }

  const now = Date.now()
  if (now - lastGlobalInsertAt < INSERT_COOLDOWN_MS || !diskCanInsert()) {
    logScan('auto-insert-blocked-global-cooldown', scanId, {
      duplicate: true,
      msRemaining: INSERT_COOLDOWN_MS - (now - lastGlobalInsertAt)
    })
    return { ...base, duplicate: true }
  }

  insertedScanIds.add(scanId)
  insertedImageFingerprints.add(imageFp)
  if (insertedScanIds.size > MAX_PROCESSED_SCANS) {
    const oldest = insertedScanIds.values().next().value
    if (oldest) insertedScanIds.delete(oldest)
  }

  const image = nativeImage.createFromDataURL(payload.imageDataUrl)
  const snapshot = saveClipboardSnapshot()

  if (!trusted) {
    if (!image.isEmpty()) clipboard.writeImage(image)
    logScan('auto-insert-skipped-no-accessibility', scanId)
    return { ...base, accessibility: false }
  }

  try {
    if (!image.isEmpty()) {
      clipboard.writeImage(image)
      await delay(200)
      await pressCmdV()
      logScan('auto-insert-image-pasted', scanId)
      await delay(500)
    }

    if (canTypeLabelDirectly(labelText)) {
      clipboard.clear()
      await delay(80)
      await typeLabelIntoField(labelText)
      logScan('auto-insert-label-typed', scanId, { insertLabel: labelText })
    } else {
      clipboard.clear()
      clipboard.writeText(labelText)
      await delay(180)
      await pressCmdV()
      logScan('auto-insert-label-pasted', scanId, { insertLabel: labelText })
      await delay(250)
    }

    restoreClipboardSnapshot(snapshot)
    lastGlobalInsertAt = Date.now()
    diskMarkInserted()
    logScan('auto-insert-done', scanId, { inserted: true, insertLabel: labelText })
    return { ...base, inserted: true }
  } catch (err) {
    restoreClipboardSnapshot(snapshot)
    const message = err instanceof Error ? err.message : 'Failed to insert into the active field.'
    logScan('auto-insert-error', scanId, { error: message })
    return { ...base, error: message }
  }
}

/**
 * Insert the scanned object into whatever app currently has focus. The overlay
 * is a non-activating window, so the user's text field keeps keyboard focus.
 * Image is pasted once via Cmd+V; the short label is typed (not pasted) so we
 * never double-fire Cmd+V for text, which was causing duplicated labels.
 */
async function insertIntoActiveField(payload: ScanCompletePayload): Promise<InsertResult> {
  const resultPromise = insertQueue.then(() => performInsert(payload))
  insertQueue = resultPromise.then(
    () => undefined,
    () => undefined
  )
  return resultPromise
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 720,
    minWidth: 640,
    minHeight: 520,
    show: false,
    title: 'Workbench Vision',
    backgroundColor: '#0f1115',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('focus', () => notifyAccessibilityStatus())
  mainWindow.webContents.on('did-finish-load', () => notifyAccessibilityStatus())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow, 'index.html')
}

const OVERLAY_W = 360
const OVERLAY_H = 120
const OVERLAY_BOTTOM_GAP = 6
// Shift the pill to the right of dead-center so the standby pill sits next to
// (rather than under) other bottom-center indicators like Wispr Flow.
const OVERLAY_RIGHT_OFFSET = 80

function overlayBottomCenter(): { x: number; y: number } {
  // workArea already excludes the Dock, so anchoring near its bottom places the
  // pill just above the Dock.
  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.round(workArea.x + (workArea.width - OVERLAY_W) / 2 + OVERLAY_RIGHT_OFFSET)
  const y = Math.round(workArea.y + workArea.height - OVERLAY_H - OVERLAY_BOTTOM_GAP)
  return { x, y }
}

function createOverlayWindow(): void {
  const { x, y } = overlayBottomCenter()
  overlayWindow = new BrowserWindow({
    width: OVERLAY_W,
    height: OVERLAY_H,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // Non-activating: keep keyboard focus on the user's current text field so
    // the scanned content can be pasted there.
    focusable: false,
    backgroundColor: '#00000000',
    title: 'Scan',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Click-through by default, but forward mouse-move events so the renderer can
  // detect hover over the pill and temporarily become interactive.
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  // Show without stealing focus from the user's active app.
  overlayWindow.once('ready-to-show', () => {
    if (!overlayWindow) return
    const pos = overlayBottomCenter()
    overlayWindow.setPosition(pos.x, pos.y)
    overlayWindow.showInactive()
  })

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  loadRenderer(overlayWindow, 'overlay.html')
}

async function ensureCameraAccess(): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    const status = systemPreferences.getMediaAccessStatus('camera')
    if (status !== 'granted') {
      await systemPreferences.askForMediaAccess('camera')
    }
  } catch {
    /* getUserMedia will surface a friendly error if access is denied */
  }
}

function ensureOverlay(): void {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow()
}

// The overlay window is persistent (it shows the standby pill at all times).
// Pressing the hotkey just toggles its internal state, so the active capture
// pill appears instantly without creating a window.
function toggleOverlay(source: 'hotkey' | 'tray' | 'reload' = 'hotkey'): void {
  const now = Date.now()
  if (now - lastOverlayToggleAt < TOGGLE_DEBOUNCE_MS) {
    logScan('overlay-toggle-debounced', 'system', { source, msSinceLast: now - lastOverlayToggleAt })
    return
  }
  if (!canSendOverlayToggle(source)) return
  lastOverlayToggleAt = now
  overlayScanActive = true
  logScan('overlay-toggle', 'system', { source, packaged: !isDev })

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(IPC.overlayToggle)
  } else {
    createOverlayWindow()
    overlayWindow?.webContents.once('did-finish-load', () => {
      overlayWindow?.webContents.send(IPC.overlayToggle)
    })
  }
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

function setupMediaPermissions(): void {
  const ses = session.defaultSession
  const isMedia = (permission: string): boolean =>
    permission === 'media' || permission === 'camera' || permission === 'microphone'

  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(isMedia(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => isMedia(permission))
}

/* ------------------------------------------------------------------ */
/* Menu-bar tray                                                       */
/* ------------------------------------------------------------------ */

// Build a small template icon (a simple camera silhouette) at runtime so we
// don't need to ship an asset. Template images are pure black + alpha; macOS
// recolors them for the menu bar (and dark mode) automatically.
function buildTrayIcon(): NativeImage {
  const size = 36
  const buf = Buffer.alloc(size * size * 4)

  // Camera body (rounded rectangle) + viewfinder bump on top.
  const bodyL = 4
  const bodyR = size - 4
  const bodyT = 13
  const bodyB = size - 6
  const bodyRad = 4
  const bumpL = size * 0.38
  const bumpR = size * 0.62
  const bumpT = 9

  // Lens: a ring (hole in the middle reads as the lens opening).
  const cx = size / 2
  const cy = (bodyT + bodyB) / 2
  const lensHole = size * 0.13

  const inRoundedRect = (x: number, y: number): boolean => {
    if (x < bodyL || x > bodyR || y < bodyT || y > bodyB) return false
    const dx = Math.max(bodyL + bodyRad - x, 0, x - (bodyR - bodyRad))
    const dy = Math.max(bodyT + bodyRad - y, 0, y - (bodyB - bodyRad))
    return dx * dx + dy * dy <= bodyRad * bodyRad
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const inBody = inRoundedRect(px, py)
      const inBump = px >= bumpL && px <= bumpR && py >= bumpT && py < bodyT
      let solid = inBody || inBump
      // Carve out the lens opening.
      if (Math.hypot(px - cx, py - cy) < lensHole) solid = false

      const i = (y * size + x) * 4
      buf[i] = 0
      buf[i + 1] = 0
      buf[i + 2] = 0
      buf[i + 3] = solid ? 255 : 0
    }
  }

  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 })
  img.setTemplateImage(true)
  return img
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
  } else {
    createMainWindow()
  }
}

function setupTray(): void {
  if (tray) return
  tray = new Tray(buildTrayIcon())
  tray.setToolTip('Workbench Vision')
  const menu = Menu.buildFromTemplate([
    { label: 'Open Workbench Vision', click: () => showMainWindow() },
    { label: 'Scan now  (⌃⌥Space)', click: () => toggleOverlay('tray') },
    { type: 'separator' },
    { label: 'Quit Workbench Vision', click: () => app.quit() }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => showMainWindow())
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  if (ipcRegistered) {
    logScan('ipc-register-skipped', 'system', { reason: 'already-registered' })
    return
  }
  ipcRegistered = true

  ipcMain.handle(IPC.runScan, async (_evt, payload: RunScanPayload) => {
    const { scanId } = payload
    if (!scanId) {
      logScan('run-scan-rejected', 'unknown', { reason: 'missing-scanId' })
      return {
        ok: false,
        found: false,
        label: '',
        insertLabel: '',
        inserted: false,
        error: 'Missing scan ID.'
      }
    }

    const existing = runScanInflight.get(scanId)
    if (existing) {
      logScan('run-scan-duplicate-ignored', scanId, { duplicate: true, reason: 'in-flight' })
      return existing
    }

    logScan('run-scan-start', scanId)
    const promise = executeRunScan(payload).finally(() => {
      runScanInflight.delete(scanId)
    })
    runScanInflight.set(scanId, promise)
    return promise
  })

  ipcMain.handle(IPC.detectObject, async (_evt, payload: DetectObjectPayload) => {
    const { scanId, dataUrl } = payload
    if (!scanId || !dataUrl) {
      logScan('ai-request-rejected', scanId || 'unknown', { reason: 'invalid-payload' })
      return { found: false, label: '', insertLabel: '', error: 'Invalid scan payload.' }
    }

    const existing = detectInflight.get(scanId)
    if (existing) {
      logScan('ai-request-duplicate-ignored', scanId, { duplicate: true })
      return existing
    }

    logScan('ai-request', scanId)
    const promise = detectObject(dataUrl)
      .then((result) => {
        logScan('ai-response', scanId, {
          found: result.found,
          label: result.label,
          insertLabel: result.insertLabel,
          error: result.error
        })
        return result
      })
      .finally(() => {
        detectInflight.delete(scanId)
      })

    detectInflight.set(scanId, promise)
    return promise
  })

  ipcMain.handle(IPC.scanSessionStarted, async (_evt, scanId: string) => {
    if (!scanId) {
      return { ok: false, duplicate: true }
    }
    if (activeOverlaySessionScanId === scanId && overlayScanActive) {
      logScan('scan-session-already-active', scanId, { duplicate: true })
      return { ok: true }
    }
    if (overlayScanActive && activeOverlaySessionScanId && activeOverlaySessionScanId !== scanId) {
      logScan('scan-session-duplicate-blocked', scanId, {
        duplicate: true,
        activeOverlaySessionScanId
      })
      return { ok: false, duplicate: true }
    }
    if (!diskSessionStart(scanId)) {
      logScan('scan-session-disk-blocked', scanId, { duplicate: true })
      return { ok: false, duplicate: true }
    }
    resetScanSessionState(scanId)
    logScan('scan-session-started', scanId, {})
    return { ok: true }
  })

  ipcMain.handle(IPC.scanSessionEnded, async (_evt, scanId?: string) => {
    const endedScanId = scanId || activeOverlaySessionScanId
    logScan('scan-session-ended', endedScanId || 'system', {
      cooldownMs: SCAN_COOLDOWN_MS
    })
    const inflight = endedScanId ? runScanInflight.get(endedScanId) : undefined
    if (inflight) {
      try {
        await inflight
      } catch {
        /* commit or failure already handled */
      }
    }
    beginScanCooldown()
    diskSessionEnd(endedScanId || undefined)
    return { ok: true }
  })

  ipcMain.handle(IPC.completeScan, async (_evt, payload: ScanCompletePayload) => {
    const { scanId } = payload
    logScan('complete-scan-deprecated', scanId || 'unknown', { duplicate: true })
    return {
      saved: false,
      inserted: false,
      accessibility: accessibilityTrusted(false),
      duplicate: true,
      scanId,
      error: 'Use run-scan instead.'
    }
  })

  ipcMain.handle(IPC.getScans, async () => getScans())

  ipcMain.handle(IPC.clearScans, async () => {
    clearScans()
    notifyScansUpdated()
    return getScans()
  })

  ipcMain.handle(IPC.deleteScan, async (_evt, id: string) => {
    deleteScan(id)
    notifyScansUpdated()
    return getScans()
  })

  ipcMain.handle(IPC.copyScan, async (_evt, id: string) => {
    const record = getScans().find((s) => s.id === id)
    if (!record) return { ok: false }
    const image = nativeImage.createFromDataURL(record.imageDataUrl)
    if (!image.isEmpty()) clipboard.writeImage(image)
    return { ok: true }
  })

  ipcMain.handle(IPC.setMouseIgnore, async (_evt, ignore: boolean) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    if (ignore) overlayWindow.setIgnoreMouseEvents(true, { forward: true })
    else overlayWindow.setIgnoreMouseEvents(false)
  })

  ipcMain.handle(IPC.openMain, async () => showMainWindow())

  ipcMain.handle(IPC.getAccessibility, async () => getAccessibilityStatus())

  ipcMain.handle(IPC.recheckAccessibility, async () => {
    const trusted = getAccessibilityStatus()
    notifyAccessibilityStatus()
    return trusted
  })

  ipcMain.handle(IPC.requestAccessibility, async () => {
    const trusted = accessibilityTrusted(true)
    if (trusted) markAccessibilityWorking()
    else notifyAccessibilityStatus()
    return trusted
  })
}

function registerGlobalShortcut(): void {
  if (shortcutRegistered) {
    console.warn('Global shortcut already registered, skipping duplicate')
    return
  }
  shortcutRegistered = true
  const ok = globalShortcut.register(HOTKEY, () => toggleOverlay('hotkey'))
  if (!ok) console.error(`Failed to register global shortcut: ${HOTKEY}`)
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    // Show in the Dock (with our app icon) in addition to the menu bar.
    // Forced explicitly so a stale Launch Services "UIElement" registration
    // can't keep the app out of the Dock.
    app.setActivationPolicy('regular')
    app.dock?.show()
    app.setAboutPanelOptions({ applicationName: 'Workbench Vision' })
  }

  loadUserEnv()
  ensureStorage()
  setupMediaPermissions()
  void ensureCameraAccess()
  registerIpc()
  createMainWindow()
  ensureOverlay() // persistent standby pill, alive for the whole session
  setupTray()
  registerGlobalShortcut()

  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

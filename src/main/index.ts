import { join } from 'path'
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
import type { InsertResult, ScanCompletePayload, ScanRecord } from '../shared/types'

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
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  const entries = [entry, ...loadIndex()]
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

/* ------------------------------------------------------------------ */
/* Inserting into the active text field of another app                 */
/* ------------------------------------------------------------------ */

function accessibilityTrusted(prompt = false): boolean {
  if (process.platform !== 'darwin') return true
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

/**
 * Insert the scanned object into whatever app currently has focus. The overlay
 * is a non-activating window, so the user's text field keeps keyboard focus.
 * Strategy: copy the image to the clipboard and paste (lands in rich targets
 * like ChatGPT/Claude/Cursor), then copy + paste the short label (lands
 * everywhere, including plain text fields).
 */
async function insertIntoActiveField(payload: ScanCompletePayload): Promise<InsertResult> {
  const labelText = payload.label
  const trusted = accessibilityTrusted(false)

  const image = nativeImage.createFromDataURL(payload.imageDataUrl)
  const previousText = clipboard.readText()

  if (!trusted) {
    // Can't synthesize keystrokes. Leave the image on the clipboard so the user
    // can paste it manually, and report that Accessibility is needed.
    if (!image.isEmpty()) clipboard.writeImage(image)
    return { saved: true, inserted: false, accessibility: false }
  }

  try {
    if (!image.isEmpty()) {
      clipboard.writeImage(image)
      await delay(140)
      await pressCmdV()
      await delay(280)
    }

    clipboard.writeText(labelText)
    await delay(120)
    await pressCmdV()
    await delay(300)

    // Restore the user's previous clipboard text (best-effort).
    clipboard.writeText(previousText)
    return { saved: true, inserted: true, accessibility: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to insert into the active field.'
    return { saved: true, inserted: false, accessibility: trusted, error: message }
  }
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
function toggleOverlay(): void {
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
    { label: 'Scan now  (⌃⌥Space)', click: () => toggleOverlay() },
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
  ipcMain.handle(IPC.detectObject, async (_evt, dataUrl: string) => detectObject(dataUrl))

  ipcMain.handle(IPC.completeScan, async (_evt, payload: ScanCompletePayload) => {
    addScan(payload)
    notifyScansUpdated()
    const result = await insertIntoActiveField(payload)
    return result
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

  ipcMain.handle(IPC.getAccessibility, async () => accessibilityTrusted(false))

  ipcMain.handle(IPC.requestAccessibility, async () => {
    const trusted = accessibilityTrusted(true)
    mainWindow?.webContents.send(IPC.accessibilityUpdated, trusted)
    return trusted
  })
}

function registerGlobalShortcut(): void {
  const ok = globalShortcut.register(HOTKEY, () => toggleOverlay())
  if (!ok) console.error(`Failed to register global shortcut: ${HOTKEY}`)
}

/* ------------------------------------------------------------------ */
/* App lifecycle                                                       */
/* ------------------------------------------------------------------ */

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

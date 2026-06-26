import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type {
  InsertResult,
  RunScanPayload,
  RunScanResult,
  ScanCompletePayload,
  ScanRecord,
  ScanSessionResult
} from '../shared/types'

// Single IPC listener for overlay hotkey — prevents duplicate handlers on remount/HMR.
let overlayToggleHandler: (() => void) | null = null
ipcRenderer.on(IPC.overlayToggle, () => {
  overlayToggleHandler?.()
})

const api = {
  // ----- Overlay (scan flow) -----
  /** One capture → one AI call → one card → one insert. */
  runScan(payload: RunScanPayload): Promise<RunScanResult> {
    return ipcRenderer.invoke(IPC.runScan, payload)
  },
  scanSessionStarted(scanId: string): Promise<ScanSessionResult> {
    return ipcRenderer.invoke(IPC.scanSessionStarted, scanId)
  },
  scanSessionEnded(scanId?: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.scanSessionEnded, scanId)
  },
  completeScan(payload: ScanCompletePayload): Promise<InsertResult> {
    return ipcRenderer.invoke(IPC.completeScan, payload)
  },
  onOverlayToggle(cb: () => void): () => void {
    overlayToggleHandler = cb
    return () => {
      if (overlayToggleHandler === cb) overlayToggleHandler = null
    }
  },
  setMouseIgnore(ignore: boolean): Promise<void> {
    return ipcRenderer.invoke(IPC.setMouseIgnore, ignore)
  },
  openMainWindow(): Promise<void> {
    return ipcRenderer.invoke(IPC.openMain)
  },

  // ----- Main window (registry) -----
  getScans(): Promise<ScanRecord[]> {
    return ipcRenderer.invoke(IPC.getScans)
  },
  clearScans(): Promise<ScanRecord[]> {
    return ipcRenderer.invoke(IPC.clearScans)
  },
  deleteScan(id: string): Promise<ScanRecord[]> {
    return ipcRenderer.invoke(IPC.deleteScan, id)
  },
  copyScan(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC.copyScan, id)
  },
  onScansUpdated(cb: (scans: ScanRecord[]) => void): () => void {
    const listener = (_e: unknown, scans: ScanRecord[]): void => cb(scans)
    ipcRenderer.on(IPC.scansUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.scansUpdated, listener)
  },

  // ----- Accessibility (auto-insert permission) -----
  getAccessibility(): Promise<boolean> {
    return ipcRenderer.invoke(IPC.getAccessibility)
  },
  requestAccessibility(): Promise<boolean> {
    return ipcRenderer.invoke(IPC.requestAccessibility)
  },
  recheckAccessibility(): Promise<boolean> {
    return ipcRenderer.invoke(IPC.recheckAccessibility)
  },
  onAccessibilityUpdated(cb: (trusted: boolean) => void): () => void {
    const listener = (_e: unknown, trusted: boolean): void => cb(trusted)
    ipcRenderer.on(IPC.accessibilityUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.accessibilityUpdated, listener)
  }
}

export type WorkbenchVisionApi = typeof api

contextBridge.exposeInMainWorld('api', api)

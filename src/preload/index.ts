import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type {
  DetectResult,
  InsertResult,
  ScanCompletePayload,
  ScanRecord
} from '../shared/types'

const api = {
  // ----- Overlay (scan flow) -----
  detectObject(dataUrl: string): Promise<DetectResult> {
    return ipcRenderer.invoke(IPC.detectObject, dataUrl)
  },
  completeScan(payload: ScanCompletePayload): Promise<InsertResult> {
    return ipcRenderer.invoke(IPC.completeScan, payload)
  },
  onOverlayToggle(cb: () => void): () => void {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.overlayToggle, listener)
    return () => ipcRenderer.removeListener(IPC.overlayToggle, listener)
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
  onAccessibilityUpdated(cb: (trusted: boolean) => void): () => void {
    const listener = (_e: unknown, trusted: boolean): void => cb(trusted)
    ipcRenderer.on(IPC.accessibilityUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.accessibilityUpdated, listener)
  }
}

export type WorkbenchVisionApi = typeof api

contextBridge.exposeInMainWorld('api', api)

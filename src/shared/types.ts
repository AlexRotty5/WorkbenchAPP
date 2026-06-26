// Shared types used across the main process, preload bridge, and renderer.

export interface DetectResult {
  found: boolean
  label: string
  error?: string
}

export interface ScanRecord {
  id: string
  label: string
  timestamp: number
  imageDataUrl: string
}

export interface ScanCompletePayload {
  imageDataUrl: string
  label: string
}

export interface InsertResult {
  saved: boolean
  inserted: boolean
  accessibility: boolean
  error?: string
}

export const IPC = {
  // overlay -> main (invoke)
  detectObject: 'detect-object',
  completeScan: 'complete-scan',
  // main window -> main (invoke)
  getScans: 'get-scans',
  clearScans: 'clear-scans',
  deleteScan: 'delete-scan',
  copyScan: 'copy-scan',
  getAccessibility: 'get-accessibility',
  requestAccessibility: 'request-accessibility',
  // overlay -> main (hover/launch)
  setMouseIgnore: 'set-mouse-ignore',
  openMain: 'open-main',
  // main -> renderer events
  overlayToggle: 'overlay-toggle',
  scansUpdated: 'scans-updated',
  accessibilityUpdated: 'accessibility-updated'
} as const

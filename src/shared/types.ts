// Shared types used across the main process, preload bridge, and renderer.

export interface DetectObjectPayload {
  scanId: string
  dataUrl: string
}

export interface DetectResult {
  found: boolean
  label: string
  insertLabel: string
  error?: string
}

export interface RunScanPayload {
  scanId: string
  dataUrl: string
}

/** Result of the atomic one-shot scan pipeline (capture → AI → card → insert). */
export interface RunScanResult {
  ok: boolean
  found: boolean
  label: string
  insertLabel: string
  inserted: boolean
  duplicate?: boolean
  /** True when the object was not identified — overlay may try another frame. */
  retryable?: boolean
  error?: string
}

export interface ScanRecord {
  id: string
  label: string
  timestamp: number
  imageDataUrl: string
}

export interface ScanCompletePayload {
  scanId: string
  imageDataUrl: string
  /** Richer label shown on the scanned object card. */
  label: string
  /** Short label pasted into the active text field. */
  insertLabel: string
}

export interface ScanSessionResult {
  ok: boolean
  duplicate?: boolean
}

export interface InsertResult {
  saved: boolean
  inserted: boolean
  accessibility: boolean
  duplicate?: boolean
  scanId?: string
  error?: string
}

export const IPC = {
  // overlay -> main (invoke) — single atomic scan pipeline
  runScan: 'run-scan',
  scanSessionStarted: 'scan-session-started',
  scanSessionEnded: 'scan-session-ended',
  detectObject: 'detect-object',
  completeScan: 'complete-scan',
  // main window -> main (invoke)
  getScans: 'get-scans',
  clearScans: 'clear-scans',
  deleteScan: 'delete-scan',
  copyScan: 'copy-scan',
  getAccessibility: 'get-accessibility',
  requestAccessibility: 'request-accessibility',
  recheckAccessibility: 'recheck-accessibility',
  // overlay -> main (hover/launch)
  setMouseIgnore: 'set-mouse-ignore',
  openMain: 'open-main',
  // main -> renderer events
  overlayToggle: 'overlay-toggle',
  scansUpdated: 'scans-updated',
  accessibilityUpdated: 'accessibility-updated'
} as const

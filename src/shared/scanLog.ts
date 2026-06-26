export interface ScanLogMeta {
  scanId?: string
  sessionGen?: number
  phase: string
  packaged?: boolean
  duplicate?: boolean
  reason?: string
  found?: boolean
  label?: string
  insertLabel?: string
  inserted?: boolean
  trigger?: string
  [key: string]: unknown
}

/** Structured scan-pipeline logging (main process + overlay renderer). */
export function scanLog(phase: string, meta: Omit<ScanLogMeta, 'phase'> = {}): void {
  console.log('[scan]', { phase, ...meta })
}

export function newScanId(): string {
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

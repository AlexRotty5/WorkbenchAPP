import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ScanRecord } from '../../shared/types'

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(ts).toLocaleDateString()
}

function App(): JSX.Element {
  const [scans, setScans] = useState<ScanRecord[]>([])
  const [accessible, setAccessible] = useState<boolean>(true)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  useEffect(() => {
    void window.api.getScans().then(setScans)
    void window.api.getAccessibility().then(setAccessible)

    const offScans = window.api.onScansUpdated(setScans)
    const offAccess = window.api.onAccessibilityUpdated(setAccessible)
    return () => {
      offScans()
      offAccess()
    }
  }, [])

  async function copy(id: string): Promise<void> {
    const res = await window.api.copyScan(id)
    if (res.ok) {
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1400)
    }
  }

  async function remove(id: string): Promise<void> {
    setScans(await window.api.deleteScan(id))
  }

  async function clearAll(): Promise<void> {
    setScans(await window.api.clearScans())
  }

  async function enableAccessibility(): Promise<void> {
    setAccessible(await window.api.requestAccessibility())
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="logo-dot" />
          <h1>Workbench Vision</h1>
        </div>
        <div className="hotkey-hint">
          <span className="kbd-group">
            <kbd>Control</kbd>
            <kbd>Option</kbd>
            <kbd>Space</kbd>
          </span>
          <span className="hotkey-label">scan an object</span>
        </div>
      </header>

      <div className="intro">
        Focus any text box (ChatGPT, Claude, Cursor, a browser…), press{' '}
        <strong>Control + Option + Space</strong>, and hold up an object. Workbench Vision detects
        it and drops the image plus a short label straight into your active field.
      </div>

      {!accessible && (
        <div className="access-banner">
          <div>
            <strong>Auto-insert is off.</strong> Grant Accessibility permission so scans can be
            typed into other apps. Until then, the scanned image is copied to your clipboard so you
            can paste it manually.
          </div>
          <button className="btn primary" onClick={() => void enableAccessibility()}>
            Enable
          </button>
        </div>
      )}

      <div className="registry-header">
        <h2>Scanned objects</h2>
        {scans.length > 0 && (
          <button className="btn ghost" onClick={() => void clearAll()}>
            Clear all
          </button>
        )}
      </div>

      <section className="registry">
        {scans.length === 0 ? (
          <div className="registry-empty">
            <p>No scans yet.</p>
            <p className="muted">
              Press <strong>Control + Option + Space</strong> while focused on any text field to
              capture your first object.
            </p>
          </div>
        ) : (
          <div className="scan-grid">
            {scans.map((s) => (
              <div className="scan-card" key={s.id}>
                <div className="scan-thumb-wrap">
                  {s.imageDataUrl ? (
                    <img className="scan-thumb" src={s.imageDataUrl} alt={s.label} />
                  ) : (
                    <div className="scan-thumb placeholder" />
                  )}
                </div>
                <div className="scan-meta">
                  <div className="scan-label" title={s.label}>
                    {s.label}
                  </div>
                  <div className="scan-time">{timeAgo(s.timestamp)}</div>
                </div>
                <div className="scan-actions">
                  <button className="btn ghost tiny" onClick={() => void copy(s.id)}>
                    {copiedId === s.id ? 'Copied' : 'Copy'}
                  </button>
                  <button className="btn ghost tiny" onClick={() => void remove(s.id)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default App

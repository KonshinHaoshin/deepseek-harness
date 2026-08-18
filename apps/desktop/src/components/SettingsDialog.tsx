/**
 * Settings dialog: per-route API key. Phase 1 supports the three hardcoded
 * catalog routes (deepseek / openai / anthropic). Adding custom providers
 * (a fourth input + probe button) lands in Phase 1.5.
 */
import { useEffect, useState } from 'react'
import { useSessionStore } from '../state/store.ts'

interface SettingsDialogProps {
  onClose: () => void
}

const ROUTES = ['deepseek', 'openai', 'anthropic'] as const
type Route = typeof ROUTES[number]

export function SettingsDialog({ onClose }: SettingsDialogProps): JSX.Element {
  const setHasApiKey = useSessionStore(state => state.setHasApiKey)
  const [keys, setKeys] = useState<Record<Route, string>>({ deepseek: '', openai: '', anthropic: '' })
  const [present, setPresent] = useState<Record<Route, boolean>>({ deepseek: false, openai: false, anthropic: false })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Record<Route, boolean> = { deepseek: false, openai: false, anthropic: false }
      for (const route of ROUTES) {
        next[route] = await window.dsh.credentials.has(route)
      }
      if (cancelled) return
      setPresent(next)
    })()
    return () => { cancelled = true }
  }, [])

  const save = async (route: Route): Promise<void> => {
    const value = keys[route].trim()
    if (value === '') return
    setBusy(true)
    try {
      await window.dsh.credentials.set(route, value)
      setPresent(prev => ({ ...prev, [route]: true }))
      setKeys(prev => ({ ...prev, [route]: '' }))
      if (route === 'deepseek') setHasApiKey(true)
    } catch (error) {
      console.error('[dsh-desktop] save credential failed', error)
      window.alert(`Failed to save key: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const clear = async (route: Route): Promise<void> => {
    setBusy(true)
    try {
      await window.dsh.credentials.clear(route)
      setPresent(prev => ({ ...prev, [route]: false }))
      if (route === 'deepseek') setHasApiKey(false)
    } catch (error) {
      console.error('[dsh-desktop] clear credential failed', error)
      window.alert(`Failed to clear key: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={event => event.stopPropagation()}>
        <header className="dialog__header">
          <h2>Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <p className="dialog__intro">
          API keys are stored in your OS keychain via Electron safeStorage. The DeepSeek key
          is required to start a session; OpenAI and Anthropic are optional.
        </p>
        {ROUTES.map(route => (
          <section key={route} className="dialog__row">
            <label>
              <span className="dialog__label">{route}</span>
              {present[route]
                ? <span className="dialog__present">key set</span>
                : <span className="dialog__missing">no key</span>}
            </label>
            <div className="dialog__input">
              <input
                type="password"
                placeholder={present[route] ? 'replace existing key' : 'paste API key'}
                value={keys[route]}
                onChange={event => setKeys(prev => ({ ...prev, [route]: event.target.value }))}
                disabled={busy}
              />
              <button type="button" onClick={() => { void save(route) }} disabled={busy || keys[route].trim() === ''}>
                Save
              </button>
              {present[route]
                ? <button type="button" onClick={() => { void clear(route) }} disabled={busy}>Clear</button>
                : null}
            </div>
          </section>
        ))}
        <footer className="dialog__footer">
          <button type="button" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}

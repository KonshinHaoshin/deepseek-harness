/**
 * Top-level renderer. Mounts the chat view, owns the IPC event subscriptions,
 * and gates input on whether the user has stored a DeepSeek API key.
 */
import { useEffect } from 'react'
import { useSessionStore, reduceEventToRow } from './state/store.ts'
import { ChatView } from './components/ChatView.tsx'
import { SettingsDialog } from './components/SettingsDialog.tsx'

export function App(): JSX.Element {
  const sessionId = useSessionStore(state => state.sessionId)
  const cwd = useSessionStore(state => state.cwd)
  const hasApiKey = useSessionStore(state => state.hasApiKey)
  const isSettingsOpen = useSessionStore(state => state.isSettingsOpen)
  const openSettings = useSessionStore(state => state.openSettings)
  const closeSettings = useSessionStore(state => state.closeSettings)
  const setHasApiKey = useSessionStore(state => state.setHasApiKey)
  const setSession = useSessionStore(state => state.setSession)
  const setCwd = useSessionStore(state => state.setCwd)
  const setStatus = useSessionStore(state => state.setStatus)
  const appendRow = useSessionStore(state => state.appendRow)

  // Hydrate persisted settings + key presence once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const settings = await window.dsh.settings.get()
      if (cancelled) return
      setCwd(settings.lastCwd)
      const has = await window.dsh.credentials.has(settings.lastRoute)
      if (cancelled) return
      setHasApiKey(has)
    })()
    return () => { cancelled = true }
  }, [setCwd, setHasApiKey])

  // Subscribe to harness notifications for the lifetime of the window.
  useEffect(() => {
    const offEvent = window.dsh.onEvent((push) => {
      if (push.sessionId !== useSessionStore.getState().sessionId) return
      const row = reduceEventToRow(push.sessionId, push.event)
      if (row !== null) appendRow(row)
    })
    const offStatus = window.dsh.onStatus((push) => {
      if (push.sessionId !== useSessionStore.getState().sessionId) return
      setStatus(push.status)
    })
    return () => { offEvent(); offStatus() }
  }, [appendRow, setStatus])

  const handleNewSession = async (): Promise<void> => {
    const settings = await window.dsh.settings.get()
    const created = await window.dsh.session.create(settings.lastCwd)
    setSession(created.sessionId, created.cwd)
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>dsh-desktop</h1>
        <span className="app__cwd">{cwd === '' ? '(no session)' : cwd}</span>
        <div className="app__actions">
          <button type="button" onClick={() => { void handleNewSession() }} disabled={!hasApiKey}>
            New session
          </button>
          <button type="button" onClick={openSettings}>Settings</button>
        </div>
      </header>
      <main className="app__main">
        {sessionId === null ? (
          <div className="empty">
            {hasApiKey
              ? 'Click "New session" to start. The first message will be sent to the DeepSeek API.'
              : 'Set your DeepSeek API key in Settings to start.'}
          </div>
        ) : (
          <ChatView sessionId={sessionId} />
        )}
      </main>
      {isSettingsOpen ? <SettingsDialog onClose={closeSettings} /> : null}
    </div>
  )
}

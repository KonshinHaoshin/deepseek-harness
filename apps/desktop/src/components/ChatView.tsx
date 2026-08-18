/**
 * Chat panel: message list + composer. Phase 1 only sends plain text; image
 * attachments and rich content blocks land in Phase 2.
 */
import { useState } from 'react'
import { useSessionStore } from '../state/store.ts'
import { MessageBubble } from './MessageBubble.tsx'

interface ChatViewProps {
  sessionId: string
}

export function ChatView({ sessionId }: ChatViewProps): JSX.Element {
  const rows = useSessionStore(state => state.rows)
  const status = useSessionStore(state => state.status)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || sending) return
    setSending(true)
    setDraft('')
    try {
      await window.dsh.message.send({
        sessionId,
        contentBlocks: [{ type: 'text', text }],
      })
    } catch (error) {
      console.error('[dsh-desktop] send failed', error)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="chat">
      <div className="chat__scroll">
        {rows.length === 0 ? (
          <div className="empty">Type a message below to start the conversation.</div>
        ) : (
          rows.map(row => <MessageBubble key={row.id} row={row} />)
        )}
      </div>
      <div className="chat__composer">
        <textarea
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void send()
            }
          }}
          placeholder={status === 'running' ? 'Agent is thinking…' : 'Send a message (Enter to send, Shift+Enter for newline)'}
          disabled={sending}
          rows={3}
        />
        <button type="button" onClick={() => { void send() }} disabled={sending || draft.trim() === ''}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

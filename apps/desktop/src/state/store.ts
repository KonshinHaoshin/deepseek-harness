/**
 * In-memory session state for one Electron window. Persisted settings
 * (last cwd / route / model) live in the main process; this store keeps
 * only the live UI state and replays session events as they arrive.
 */
import { create } from 'zustand'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One rendered row in the chat view. */
export interface MessageRow {
  id: string
  sessionId: string
  kind: 'user' | 'assistant' | 'tool' | 'system'
  /** Plain text; complex content blocks are flattened to a single string in Phase 1. */
  text: string
  /** Event seq within the session, used to dedupe replays. */
  seq: number
}

interface SessionState {
  sessionId: string | null
  cwd: string
  status: 'idle' | 'running'
  rows: MessageRow[]
  hasApiKey: boolean
  isSettingsOpen: boolean
}

interface SessionActions {
  setSession(sessionId: string, cwd: string): void
  setCwd(cwd: string): void
  setStatus(status: 'idle' | 'running'): void
  appendRow(row: MessageRow): void
  setRows(rows: MessageRow[]): void
  setHasApiKey(value: boolean): void
  openSettings(): void
  closeSettings(): void
}

export const useSessionStore = create<SessionState & SessionActions>(set => ({
  sessionId: null,
  cwd: '',
  status: 'idle',
  rows: [],
  hasApiKey: false,
  isSettingsOpen: false,
  setSession: (sessionId, cwd) => set({ sessionId, cwd, rows: [] }),
  setCwd: cwd => set({ cwd }),
  setStatus: status => set({ status }),
  appendRow: row => set((state) => {
    if (state.rows.some(existing => existing.id === row.id)) return state
    return { rows: [...state.rows, row] }
  }),
  setRows: rows => set({ rows }),
  setHasApiKey: value => set({ hasApiKey: value }),
  openSettings: () => set({ isSettingsOpen: true }),
  closeSettings: () => set({ isSettingsOpen: false }),
}))

/**
 * Reduce one wire event to a renderable row. Phase 1 flattens all block
 * types to text; tool calls and images will gain proper rendering in
 * Phase 2. Stream chunks are ignored until Phase 2 wires live streaming.
 *
 * `SessionEvent` carries its payload under `data`; the discriminator `type`
 * is the only field on the outer envelope.
 */
export function reduceEventToRow(sessionId: string, event: SessionEvent): MessageRow | null {
  const type = event.type
  if (type === 'user/message') {
    const data = event.data
    const text = data.content
      .filter(block => block.type === 'text')
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    return { id: `${sessionId}:${String(event.seq)}:user`, sessionId, kind: 'user', text, seq: event.seq }
  }
  if (type === 'assistant/message') {
    const data = event.data
    const blocks = data.message.content
    const text = blocks
      .filter(block => block.type === 'text' || block.type === 'reasoning')
      .map(block => (block.type === 'text' || block.type === 'reasoning' ? block.text : ''))
      .join('\n')
    return { id: `${sessionId}:${String(event.seq)}:assistant`, sessionId, kind: 'assistant', text, seq: event.seq }
  }
  if (type === 'tool/call') {
    const data = event.data
    return {
      id: `${sessionId}:${String(event.seq)}:tool-call`,
      sessionId,
      kind: 'tool',
      text: `→ ${data.name}`,
      seq: event.seq,
    }
  }
  if (type === 'tool/result') {
    const data = event.data
    const firstBlock = data.message.content[0]
    const callId = firstBlock !== undefined && firstBlock.type === 'tool-result' ? firstBlock.toolCallId : 'unknown'
    return {
      id: `${sessionId}:${String(event.seq)}:tool-result`,
      sessionId,
      kind: 'tool',
      text: `← ${callId}`,
      seq: event.seq,
    }
  }
  return null
}

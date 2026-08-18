/**
 * Augment the global `Window` with the bridge exposed by the preload script.
 * The renderer never imports `electron`; everything reaches Node-land through
 * the `dsh.*` surface declared here.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export type SessionStatus = 'idle' | 'running'

export interface SessionEventPush {
  sessionId: string
  event: SessionEvent
}

export interface SessionStatusPush {
  sessionId: string
  status: SessionStatus
}

export interface DshBridge {
  session: {
    create(cwd?: string): Promise<{ sessionId: string; cwd: string }>
  }
  message: {
    send(payload: { sessionId: string; contentBlocks: ContentBlock[] }): Promise<{ messageId: string }>
  }
  process: {
    restart(): Promise<void>
  }
  credentials: {
    has(route: string): Promise<boolean>
    set(route: string, apiKey: string): Promise<void>
    clear(route: string): Promise<void>
  }
  settings: {
    get(): Promise<{ lastCwd: string; lastRoute: string; lastModel: string }>
  }
  onEvent(callback: (push: SessionEventPush) => void): () => void
  onStatus(callback: (push: SessionStatusPush) => void): () => void
}

declare global {
  interface Window {
    dsh: DshBridge
  }
}

export {}

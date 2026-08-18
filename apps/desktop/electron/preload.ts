/**
 * Preload bridge: the only surface the renderer can reach across the
 * context-isolation boundary. The renderer never imports `electron` or
 * `node:*`; everything crosses through `window.dsh.*` defined here.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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

const bridge: DshBridge = {
  session: {
    create: cwd => ipcRenderer.invoke('dsh:session.create', cwd === undefined ? {} : { cwd }) as Promise<{ sessionId: string; cwd: string }>,
  },
  message: {
    send: payload => ipcRenderer.invoke('dsh:message.send', payload) as Promise<{ messageId: string }>,
  },
  process: {
    restart: () => ipcRenderer.invoke('dsh:process.restart') as Promise<void>,
  },
  credentials: {
    has: route => ipcRenderer.invoke('dsh:credentials.has', { route }) as Promise<boolean>,
    set: (route, apiKey) => ipcRenderer.invoke('dsh:credentials.set', { route, apiKey }) as Promise<void>,
    clear: route => ipcRenderer.invoke('dsh:credentials.clear', { route }) as Promise<void>,
  },
  settings: {
    get: () => ipcRenderer.invoke('dsh:settings.get') as Promise<{ lastCwd: string; lastRoute: string; lastModel: string }>,
  },
  onEvent(callback) {
    const listener = (_event: IpcRendererEvent, push: SessionEventPush): void => callback(push)
    ipcRenderer.on('dsh:event', listener)
    return () => ipcRenderer.off('dsh:event', listener)
  },
  onStatus(callback) {
    const listener = (_event: IpcRendererEvent, push: SessionStatusPush): void => callback(push)
    ipcRenderer.on('dsh:status', listener)
    return () => ipcRenderer.off('dsh:status', listener)
  },
}

contextBridge.exposeInMainWorld('dsh', bridge)

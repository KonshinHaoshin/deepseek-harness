/**
 * Electron main process for `dsh-desktop`.
 *
 * Spawns the DeepSeek Harness JSON-RPC runtime as a child process, bridges
 * its notifications and request surface to the renderer over IPC, and stores
 * per-route API keys in Electron's `safeStorage`. The wire protocol in
 * `@deepseek-ai/dsh-sdk-protocol` is the only contract the shell holds with
 * the runtime; no harness internal module is imported here.
 *
 * The harness child is started in `app.whenReady` and torn down in
 * `before-quit` through `HarnessClient.close()`.
 */
import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { HarnessClient, TransportClosedError } from '@deepseek-ai/dsh-sdk-client'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Bundled `@deepseek-ai/dsh-sdk-jsonrpc-demo` built entry. `lib/bin.js` is
 * the product of `pnpm run build`; the source-tree `src/bin.ts` only
 * matters for the package's own dev workflow.
 */
function resolveHarnessBin(): string {
  const pkgJson = require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/package.json')
  return join(dirname(pkgJson), 'lib', 'bin.js')
}

/** Spawn the runtime in `ELECTRON_RUN_AS_NODE` mode so the Electron binary behaves as a plain Node host. */
function harnessBinArgs(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [resolveHarnessBin()],
  }
}

/** Per-route API keys, encrypted with `safeStorage` and persisted to userData. */
interface CredentialsFile {
  version: 1
  routes: Record<string, string>
}

const CREDENTIALS_VERSION = 1 as const
const CREDENTIALS_FILE = 'credentials.bin'

/** Configured provider routes + last-used selection, persisted to userData. */
interface SettingsFile {
  lastCwd: string
  lastRoute: string
  lastModel: string
}

const SETTINGS_FILE = 'settings.json'

/** Active harness client; null between app start and first launch, or after a close. */
let client: HarnessClient | null = null
/** Active window; null until `whenReady` creates it. */
let mainWindow: BrowserWindow | null = null
/** Persisted selection, hydrated at startup. */
let settings: SettingsFile = {
  lastCwd: app.getPath('home'),
  lastRoute: 'deepseek',
  lastModel: 'deepseek-v4-pro',
}

function userData(...parts: string[]): string {
  return join(app.getPath('userData'), ...parts)
}

function readJsonOrDefault<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function loadSettings(): void {
  const file = userData(SETTINGS_FILE)
  const parsed = readJsonOrDefault<Partial<SettingsFile>>(file, {})
  settings = {
    lastCwd: parsed.lastCwd ?? app.getPath('home'),
    lastRoute: parsed.lastRoute ?? 'deepseek',
    lastModel: parsed.lastModel ?? 'deepseek-v4-pro',
  }
}

function saveSettings(): void {
  writeFileSync(userData(SETTINGS_FILE), JSON.stringify(settings, null, 2), 'utf8')
}

function loadCredentials(): CredentialsFile {
  const file = userData(CREDENTIALS_FILE)
  if (!existsSync(file)) return { version: CREDENTIALS_VERSION, routes: {} }
  if (!safeStorage.isEncryptionAvailable()) return { version: CREDENTIALS_VERSION, routes: {} }
  try {
    const plaintext = safeStorage.decryptString(readFileSync(file))
    const parsed = JSON.parse(plaintext) as CredentialsFile
    if (parsed.version !== CREDENTIALS_VERSION) return { version: CREDENTIALS_VERSION, routes: {} }
    return parsed
  } catch {
    return { version: CREDENTIALS_VERSION, routes: {} }
  }
}

function saveCredentials(file: CredentialsFile): void {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage encryption is not available on this OS')
  const blob = safeStorage.encryptString(JSON.stringify(file))
  writeFileSync(userData(CREDENTIALS_FILE), blob)
}

/**
 * Build the environment passed to the harness child. Per-route keys resolve
 * through `safeStorage`; the LLM adapter reads them on every request, so a
 * key the user just set shows up without a restart.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const creds = loadCredentials()
  const env: NodeJS.ProcessEnv = { ...process.env }
  env['DSH_HOME'] = app.getPath('userData')
  env['DSH_SESSIONS_DB_PATH'] = userData('sessions.db')
  env['DSH_CORDIS_CONFIG'] = join(__dirname, '..', 'cordis.yml')
  // Phase 1 hardcodes the three catalog routes' env names. Custom providers
  // added through the LLM Providers panel will land in Phase 1.5, where the
  // shell writes its own dynamic `apiKeyEnv` into settings.yaml.
  const routeEnv: Record<string, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
  }
  for (const [route, envName] of Object.entries(routeEnv)) {
    const stored = creds.routes[route]
    if (typeof stored === 'string' && stored.length > 0) env[envName] = stored
  }
  return env
}

function spawnHarness(): HarnessClient {
  const { command, args } = harnessBinArgs()
  const child = new HarnessClient({
    command,
    args,
    cwd: settings.lastCwd,
    env: {
      ...buildChildEnv(),
      // Tell Electron's bundled Node to drop its UI behavior and run as a
      // pure Node host; without this, the spawn tries to drive a window.
      ELECTRON_RUN_AS_NODE: '1',
    },
    requestTimeoutMs: 60_000,
  })
  child.start()
  return child
}

async function ensureHarness(): Promise<HarnessClient> {
  if (client !== null) return client
  const harness = spawnHarness()
  client = harness
  // Re-broadcast every session event from the runtime into the renderer.
  // The renderer is the single UI surface; the main process doesn't need
  // its own copy of the event log.
  const sub = harness.subscribe()
  void (async () => {
    try {
      for await (const notification of sub) {
        if (mainWindow === null || mainWindow.isDestroyed()) continue
        if (notification.method === 'session.event') {
          const params = notification.params as { sessionId: string; event: SessionEvent }
          mainWindow.webContents.send('dsh:event', params)
        } else if (notification.method === 'session.status') {
          const params = notification.params as { sessionId: string; status: 'idle' | 'running' }
          mainWindow.webContents.send('dsh:status', params)
        } else if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
          mainWindow.webContents.send('dsh:event', notification.params)
        }
      }
    } catch (error) {
      if (!(error instanceof TransportClosedError)) {
        console.error('[dsh-desktop] notification stream error', error)
      }
    }
  })()
  return harness
}

async function initializeHarness(cwd: string, provider: string, model: string): Promise<void> {
  const harness = await ensureHarness()
  await harness.initialize({ cwd, provider, model })
  settings.lastCwd = cwd
  settings.lastRoute = provider
  settings.lastModel = model
  saveSettings()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // Open external links in the OS browser, never in the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '..', '..', 'out', 'renderer', 'index.html'))
  }
}

/**
 * Surface a startup error to the user; the runtime prints a stderr tail in
 * `TransportClosedError` which is the only diagnostic most users will see.
 */
function registerIpc(): void {
  ipcMain.handle('dsh:session.create', async (_event, payload: { cwd?: string }) => {
    const cwd = payload.cwd ?? settings.lastCwd
    if (!existsSync(cwd)) throw new Error(`working directory does not exist: ${cwd}`)
    await initializeHarness(cwd, settings.lastRoute, settings.lastModel)
    return { sessionId: randomUUID(), cwd }
  })

  ipcMain.handle('dsh:message.send', async (_event, payload: { sessionId: string; contentBlocks: ContentBlock[] }) => {
    const harness = await ensureHarness()
    const messageId = await harness.prompt(payload.sessionId, payload.contentBlocks)
    return { messageId }
  })

  ipcMain.handle('dsh:process.restart', async () => {
    if (client !== null) {
      try {
        await client.close()
      } catch (error) {
        console.error('[dsh-desktop] harness close failed', error)
      }
      client = null
    }
    await initializeHarness(settings.lastCwd, settings.lastRoute, settings.lastModel)
  })

  ipcMain.handle('dsh:credentials.has', async (_event, payload: { route: string }) => {
    const creds = loadCredentials()
    return typeof creds.routes[payload.route] === 'string' && creds.routes[payload.route]!.length > 0
  })

  ipcMain.handle('dsh:credentials.set', async (_event, payload: { route: string; apiKey: string }) => {
    const creds = loadCredentials()
    creds.routes[payload.route] = payload.apiKey
    saveCredentials(creds)
    // Re-spawn so the new key reaches the env on the next initialize.
    if (client !== null) {
      try {
        await client.close()
      } catch (error) {
        console.error('[dsh-desktop] harness close on credential change failed', error)
      }
      client = null
    }
  })

  ipcMain.handle('dsh:credentials.clear', async (_event, payload: { route: string }) => {
    const creds = loadCredentials()
    delete creds.routes[payload.route]
    saveCredentials(creds)
  })

  ipcMain.handle('dsh:settings.get', async () => settings)
}

app.whenReady().then(() => {
  mkdirSync(app.getPath('userData'), { recursive: true })
  loadSettings()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  if (client === null) return
  try {
    await client.close()
  } catch (error) {
    console.error('[dsh-desktop] harness close on quit failed', error)
  } finally {
    client = null
  }
})

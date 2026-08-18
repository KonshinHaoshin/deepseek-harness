// Smoke test: spawn dsh-jsonrpc-agent, send initialize, verify response.
// Run: node apps/desktop/scripts/smoke.mjs
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const DSH_HOME = userData
const DSH_SESSIONS_DB_PATH = join(userData, 'sessions.db')
const DSH_CORDIS_CONFIG = new URL('../cordis.yml', import.meta.url).pathname

const client = new HarnessClient({
  command: 'node',
  args: [new URL('../../../packages/examples/jsonrpc-demo/lib/bin.js', import.meta.url).pathname],
  cwd: '/tmp',
  env: {
    ...process.env,
    DSH_HOME,
    DSH_SESSIONS_DB_PATH,
    DSH_CORDIS_CONFIG,
    DEEPSEEK_API_KEY: 'sk-fake-for-smoke-test',
  },
  requestTimeoutMs: 30_000,
})

try {
  console.log('[smoke] starting harness...')
  client.start()
  console.log('[smoke] sending initialize...')
  const result = await client.initialize({
    cwd: '/tmp',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
  })
  console.log('[smoke] initialize result:', JSON.stringify(result, null, 2))
  console.log('[smoke] sending session/prompt...')
  const sessionId = 'smoke-' + Date.now()
  const messageId = await client.prompt(sessionId, [{ type: 'text', text: 'hello, say one word' }])
  console.log('[smoke] prompt enqueued, messageId:', messageId)
  // Listen for the first 3 notifications, then bail.
  const sub = client.subscribe()
  const events = []
  const deadline = Date.now() + 30_000
  while (events.length < 3 && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const next = await Promise.race([
      sub.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('events timeout')), remaining)),
    ])
    events.push(next)
    console.log('[smoke] event', events.length, ':', next.method, JSON.stringify(next.params).slice(0, 200))
  }
  sub.close()
  console.log('[smoke] total events received:', events.length)
  console.log('[smoke] PASS')
} catch (err) {
  console.error('[smoke] FAILED:', err.message)
  process.exitCode = 1
} finally {
  try { await client.close() } catch (e) { /* ignore */ }
  rmSync(userData, { recursive: true, force: true })
}

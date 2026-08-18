# `dsh-desktop` Plan

A Claude-Desktop-style Electron shell for the DeepSeek Harness runtime, living in this monorepo as `apps/desktop/`.
The runtime stays in `packages/*`; the shell adds a window, a chat pane, and BYOK key storage on top of the existing JSON-RPC SDK.
This document captures the architecture, the upstream-sync constraints, and the staged plan that keeps the shell thin enough to track DeepSeek Harness releases.

## Goal

Ship a desktop app whose only contract with the harness is the wire protocol in [`@deepseek-ai/dsh-sdk-protocol`](../../packages/sdk/protocol/src/types.ts).
The shell does not import any harness internal module; the runtime is spawned as a child process and the shell drives it over stdio JSON-RPC.
The shell survives upstream refactors as long as the wire protocol keeps its current method and notification set.

## Non-goals

- A new agent loop, tool registry, or session backend in the shell. Those live in `packages/`.
- A custom LLM provider implementation. The shell uses `@deepseek-ai/dsh-llm-pi-ai` and configures provider routes in `cordis.yml` plus the user's `settings.yaml`; the shell never sees provider internals.
- A custom persistence format. Sessions live in the harness's own SQLite backend (`@deepseek-ai/dsh-session-persistence-sqlite`).
- A web/IDE-style UI. Phase 1 covers the chat-with-sessions shape; multi-pane workflows are out of scope until Phase 3 at the earliest.
- A bundled default API key. Users bring their own; the shell stores them via Electron `safeStorage`.

## Architecture

```
┌──────────────────────────┐    contextBridge     ┌──────────────────────────┐
│  Renderer (React)        │ ◄─────────────────► │  Main process            │
│  - Session list          │                      │  - Spawns dsh child      │
│  - Chat view             │                      │  - Wraps HarnessClient   │
│  - Settings dialog       │                      │  - Holds IPC handlers    │
└──────────────────────────┘                      └────────────┬─────────────┘
                                                                │ stdio JSON-RPC
                                                                ▼
                                                ┌──────────────────────────┐
                                                │  dsh-jsonrpc-agent child │
                                                │  (cordis.yml driven)     │
                                                │  - LLM provider          │
                                                │  - Agent loop            │
                                                │  - SQLite persistence    │
                                                └──────────────────────────┘
```

The shell's process boundary is the JSON-RPC client/server seam in [`@deepseek-ai/dsh-sdk-client`](../../packages/sdk/client/src/client.ts) and [`@deepseek-ai/dsh-sdk-jsonrpc-server`](../../packages/sdk/server/src/server.ts).
The wire is newline-delimited JSON-RPC 2.0; the shell consumes the three request methods and the four server notifications defined in [`protocol/types.ts`](../../packages/sdk/protocol/src/types.ts).

## Process responsibilities

| Process | Owns | Must not own |
|---|---|---|
| Renderer | UI state, Markdown render, event-to-bubble mapping | Any Node API, any IPC beyond `window.dsh.*` |
| Main | `HarnessClient` lifecycle, IPC handler bridge, `safeStorage` wrapping, child-process supervision | UI rendering, file formatting |
| Harness child | LLM, tools, session log, persistence | Window management, network access, key storage |

## Repository layout

```
apps/desktop/
├── PLAN.md                  this document
├── README.md                consumer-facing quickstart (Phase 1 stub)
├── package.json             electron, vite, react, zustand, dsh-sdk-client
├── tsconfig.json
├── electron.vite.config.ts  main / preload / renderer triple-build
├── cordis.yml               runtime composition (LLM + tools + persistence)
├── electron/
│   ├── main.ts              app entry, BrowserWindow, child-process supervision
│   ├── preload.ts           contextBridge.exposeInMainWorld('dsh', api)
│   ├── harness-client.ts    HarnessClient wrapper, restart-on-crash
│   ├── ipc/
│   │   ├── session.ts       list / create / load / delete
│   │   ├── message.ts       send / stream / cancel
│   │   └── credentials.ts   safeStorage read / write / clear
│   └── safe-storage.ts      safeStorage adapter
├── src/                     renderer
│   ├── main.tsx
│   ├── App.tsx              session list + chat view + settings
│   ├── components/
│   │   ├── SessionList.tsx
│   │   ├── ChatView.tsx
│   │   ├── MessageBubble.tsx
│   │   └── SettingsDialog.tsx
│   ├── state/
│   │   ├── session.ts       zustand store
│   │   ├── messages.ts      per-session message log (from session.event)
│   │   └── credentials.ts   key presence flag
│   └── ipc.ts               typed window.dsh.* wrappers
├── resources/
│   └── icon.png
└── tests/
    ├── main/                smoke tests for IPC handler shape
    └── renderer/            component tests (vitest + @testing-library/react)
```

## IPC contract (renderer ↔ main)

| Channel | Direction | Payload | Notes |
|---|---|---|---|
| `dsh:session.list` | invoke | `void` → `SessionMeta[]` | titles + timestamps from `cordis.yml`-configured title service |
| `dsh:session.create` | invoke | `{ cwd?: string }` → `SessionMeta` | cwd defaults to `app.getPath('home')` |
| `dsh:session.delete` | invoke | `{ sessionId }` → `void` | drops SQLite rows + in-memory cache |
| `dsh:message.send` | invoke | `{ sessionId, contentBlocks }` → `{ messageId }` | enqueues a user prompt; reply comes via `dsh:event` push |
| `dsh:message.stream` | event push | `SessionEventNotification` | every `session.event` from the runtime, scoped to the active session tree |
| `dsh:status` | event push | `SessionStatusNotification` | `idle` ↔ `running` per session |
| `dsh:credentials.has` | invoke | `void` → `boolean` | drives the "set API key" prompt |
| `dsh:credentials.set` | invoke | `{ providerRoute, apiKey }` → `void` | stored via `safeStorage`; on next harness spawn each route's key is exposed under its `apiKeyEnv` env |
| `dsh:credentials.clear` | invoke | `{ providerRoute }` → `void` | removes the encrypted blob for that route |
| `dsh:providers.list` | invoke | `void` → `ProviderRoute[]` | the effective provider set (composition base ∪ user settings) with masked credential status |
| `dsh:providers.upsert` | invoke | `{ route: ProviderRoute }` → `void` | writes to `llm-pi-ai.providers.<key>` in `$DSH_HOME/settings.yaml`; atomic swap, effective next request |
| `dsh:providers.delete` | invoke | `{ routeKey }` → `void` | removes the route from settings; the route is dropped on next request |
| `dsh:providers.probe` | invoke | `{ baseURL, apiKey? }` → `{ models: Model[] }` | calls `ctx.llm.registerModelDiscovery('llm-pi-ai', …)` over the endpoint; used by the "Add custom provider" dialog |
| `dsh:process.restart` | invoke | `void` → `void` | only after a `dsh:process.died` push; used for the "retry" button |

Cancel semantics: the wire has no per-request cancel ([`HarnessClient.request` only supports timeout](../../packages/sdk/client/src/client.ts)).
The shell's "stop" affordance either waits for the agent loop's own stop reason or tears down the harness child via `HarnessClient.close()` and respawns.

## Event-to-UI mapping

The runtime pushes every `SessionEvent` for every session in the context; the client filters to one session tree via `subscribeSessionTree`.
The shell then maps by event type:

| Event type | UI rendering |
|---|---|
| `user/message` | new user bubble |
| `assistant/message` | new assistant bubble with final text |
| `assistant/chunk` | append to the in-flight assistant bubble (streaming) |
| `tool_use` | collapsible "tool call" block, name + args |
| `tool_result` | result block, success or error styling |
| `agent/status` | header "thinking…" indicator |
| `session/created` | appears in the session list once title arrives |
| `subagent.started` | nested child block under the active assistant message |
| `subagent.finished` | close the nested child block |

`SessionEvent` shapes come from [`@deepseek-ai/dsh-session`](../../packages/session); the shell pins a peer dep on the same minor as the runtime package and never imports the type at runtime in the renderer — types flow through `apps/desktop/src/types/session-events.d.ts` regenerated by `pnpm run doc-sync`.

## `cordis.yml` design

The runtime boots from a single config file; the shell ships one in `apps/desktop/cordis.yml` and overlays per-user values at spawn time.

Base composition (copied from [`examples/headless-agent/cordis.yml`](../../examples/headless-agent/cordis.yml) and trimmed):

- `@deepseek-ai/dsh-settings-file` — hot-reloads `$DSH_HOME/settings.yaml`
- `@deepseek-ai/dsh-credentials-local` — resolves per-route API keys from the local credential store
- `@deepseek-ai/dsh-llm-pi-ai` — the multi-provider LLM adapter; composition base declares three catalog routes (DeepSeek, OpenAI, Anthropic) and a hand-declared `custom:` route the user's settings fill in
- `@deepseek-ai/dsh-subprocess-local` + `@deepseek-ai/dsh-bash-local` — managed bash executor
- `@deepseek-ai/dsh-agent-spine-demo` — the default spine, with one `main` agent
- `@deepseek-ai/dsh-session-persistence-sqlite` — durable session log; path is `!!js path.join(app.getPath('userData'), 'sessions.db')`
- `@deepseek-ai/dsh-session-title` — auto-titles
- `@deepseek-ai/dsh-fs-local` + `@deepseek-ai/dsh-fs-observation-policy` + `@deepseek-ai/dsh-tool-fs` — filesystem tools
- `@deepseek-ai/dsh-tool-bash` — bash tool
- `@deepseek-ai/dsh-tool-todo` — todo tool
- `@deepseek-ai/dsh-tool-skill` + `@deepseek-ai/dsh-skill` + `@deepseek-ai/dsh-skill-filesystem` — skill loading
- `@deepseek-ai/dsh-token-meter` + `@deepseek-ai/dsh-compaction-basic` — context window management
- `@deepseek-ai/dsh-session-checkpoint-policy` — checkpoint on `session/flush`

Phase 1 omits: workflow, ralph, subagent delegation, web search, e2b, ACP, lsp, multi-window, telemetry, cross-device sync. The shell adds them as separate runtime config toggles in later phases.

LLM provider management is a first-class Phase 1 surface: a "LLM Providers" settings panel lists the effective routes (composition base ∪ user settings), lets the user add a custom route by entering a base URL plus an API key and probing `/v1/models`, edit the credential, and delete routes. All writes go through `dsh:providers.upsert` / `dsh:providers.delete` to `$DSH_HOME/settings.yaml` under `llm-pi-ai.providers.*`.

User overlay at spawn time:
- `cwd` for the `main` agent — the user's chosen working directory, persisted in `app.getPath('userData')/last-cwd.json`
- LLM route + model selection — the user's pick from the effective provider set; persisted under `last-llm.json`
- API key per route — passed via the child process env (`<apiKeyEnv>`), sourced from `safeStorage` keyed by `providerRoute`

The config is validated at boot via `dsh-app-boot`; a load failure is a fatal start error and the shell shows a diagnostic dialog with the stderr tail from `HarnessClient.closedError`.

## Upstream-sync strategy

The shell survives `git fetch upstream && git rebase upstream/master` by holding a narrow import surface and a small set of pinned contracts.

**Stable imports (allowed from `apps/desktop/`):**
- `@deepseek-ai/dsh-sdk-client` — `HarnessClient`, `HarnessClientOptions`
- `@deepseek-ai/dsh-sdk-protocol` — `InitializeParams`, `SessionEvent`, the four notification payloads
- `electron`, `react`, `zustand`, `vite`

**Forbidden imports (any of these blocks an upstream rebase):**
- Any other `@deepseek-ai/dsh-*` package — go through the wire instead
- `node:sqlite` directly — the harness owns the database
- Any path under `packages/sdk/server/src/` from the shell's code

**Version pinning:**
- `apps/desktop/package.json` pins each harness dep at `~0.4.x` (auto-bump on minor, manual review on major)
- The shell's CI runs `pnpm install` and the harness's existing `pnpm run test` against the pinned range; breakage means a release-notes review, not a hot patch in the shell
- The shell's snapshot tests pin the harness at an exact tag (`harness-v0.4.5`) to keep fixture diffs stable

**Sync cadence:**
- Weekly: `git fetch upstream && git rebase upstream/master` on a `sync/upstream-<date>` branch
- Per-sync: `pnpm install && pnpm run typecheck && pnpm run test && pnpm --filter @deepseek-ai/dsh-desktop build`
- Conflict in `apps/desktop/`: usually means the wire protocol changed — fix by bumping the shell's pinned range and adapting the IPC handlers, never by editing `packages/`

## Phased roadmap

### Phase 1 — MVP (target: 3-5 days from kickoff)

- [ ] `apps/desktop/package.json` with `electron`, `vite`, `react`, `zustand`, `@deepseek-ai/dsh-sdk-client`
- [ ] `apps/desktop/cordis.yml` mirroring `headless-agent`, trimmed, with `dsh-llm-pi-ai` + three catalog routes (DeepSeek, OpenAI, Anthropic)
- [ ] `electron/main.ts` spawns `node_modules/.bin/dsh-jsonrpc-agent` with `DSH_CORDIS_CONFIG=apps/desktop/cordis.yml`
- [ ] `electron/preload.ts` exposes the IPC contract above
- [ ] `src/App.tsx` with session list, chat view, settings dialog
- [ ] `safeStorage`-backed credential storage, keyed by `providerRoute`
- [ ] LLM Providers settings panel: list routes, add via `/v1/models` probe, edit key, delete
- [ ] Manual smoke: launch → set DeepSeek key → send "hello" → see response → add a custom OpenAI-compatible route → switch to it → close and reopen sees the same sessions

### Phase 2 — UX completeness (target: 1-2 weeks)

- [ ] `assistant/chunk` → live streaming bubble (no need to wait for `assistant/message`)
- [ ] Tool calls render as collapsible cards with input/output
- [ ] Subagent blocks nest under the active assistant message
- [ ] Markdown + syntax highlighting (Shiki) for code blocks
- [ ] Session rename + delete
- [ ] Per-session `cwd` override

### Phase 3 — Distribution and ops (target: 2-4 weeks)

- [ ] `electron-builder` config for macOS / Windows / Linux
- [ ] Code signing (Developer ID on macOS, EV cert on Windows)
- [ ] `electron-updater` for auto-update, pinned to a GitHub release channel
- [ ] Multi-window support: secondary windows share the single `HarnessClient` and route by `sessionId`
- [ ] `scripts/sync-upstream.sh` codifying the weekly rebase

### Phase 4 — Beyond chat (deferred)

- LSP integration
- File tree / IDE-style editing
- Per-project settings (`.dsh-desktop/`)
- Plugin / skill authoring UI
- Cross-device session export / import
- Crash reporter + telemetry opt-in

## Key risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Upstream renames a wire method or notification | Low (wire is `0.0.1` and `SERVER_FORMAT_VERSION` policies apply) | High (full rewire) | Pin to a `~` range; rebase weekly; track `dsh-sdk-protocol` CHANGELOG |
| Native addons in `native/` break under Electron's Node ABI | Medium | High (release blocker) | `apps/desktop` does not use `native/`; we use `node:sqlite` which is bundled in Node 22.5+ |
| `node:sqlite` unavailable in user's Node version | Low | Medium (no persistence) | Document Node 22.5+ requirement in `apps/desktop/README.md`; fall back to `dsh-session-persistence-jsonl` if needed |
| `dsh-jsonrpc-agent` bin path differs between dev and packaged app | Medium | Medium (broken start) | Resolve bin path via `require.resolve('@deepseek-ai/dsh-sdk-jsonrpc-demo/bin')`; bundle its `lib/` into the asar |
| API key leak via Electron logs | Low | Critical | Never log the key; `safeStorage` only; strip `DEEPSEEK_API_KEY` from any captured env in `crashReporter` |
| Long-running agent blocks the UI "stop" button | High | Medium (UX) | `HarnessClient.close()` + respawn; surface a "killing…" state with timeout |
| Renderer re-asks the harness for already-replayed events | Medium | Low (wasted bandwidth) | Client tracks `lastSeq` per session; UI ignores events with `seq <= lastSeq` |
| Multiple windows spawn multiple harness children | Medium | High (resource) | Main process owns a single `HarnessClient`; renderer-to-renderer sync over a broadcast channel |

## Sync-upstream script (Phase 3 deliverable, sketched now)

```sh
#!/usr/bin/env bash
# scripts/sync-upstream.sh
set -euo pipefail

REMOTE="${UPSTREAM_REMOTE:-upstream}"
BRANCH="${BRANCH:-master}"
DATE="$(date -u +%Y-%m-%d)"
WORK="sync/upstream-${DATE}"

git fetch "$REMOTE" "$BRANCH"
git worktree add -b "$WORK" "$WORK" "$REMOTE/$BRANCH"
git checkout "$WORK"

pnpm install
pnpm run typecheck
pnpm run test
pnpm --filter @deepseek-ai/dsh-desktop build
pnpm --filter @deepseek-ai/dsh-desktop test:snapshot

git checkout -
git branch -D "$WORK"
git worktree remove "$WORK"
```

The script never edits `packages/*`; if it fails it prints the failed harness test and stops.

## Confirmed decisions (review lock)

| Question | Decision | Why |
|---|---|---|
| LSP / file-tree | Phase 4 | Chat-only is enough for the first smoke test; adding LSP doubles Phase 1 cost without proving product value |
| Custom LLM providers | Phase 1, `dsh-llm-pi-ai` as the only LLM plugin; base composition ships DeepSeek + OpenAI + Anthropic catalog routes; user adds custom OpenAI-compatible routes through the settings panel | `dsh-llm-pi-ai` already supports catalog routes, hand-declared routes, per-request profile resolution, and `/v1/models` probe — the desktop app only writes `settings.yaml` |
| Telemetry | None in Phase 1-2 | BYOK personal tool; no first-party telemetry without an explicit post-launch decision |
| Window model | Phase 1 single window with tabs; Phase 3 multi-window sharing a single `HarnessClient` | Single resource owner keeps the process model simple; multi-window is a later nice-to-have without rearchitecting the main process |
| Cross-device sync | Out of scope | SQLite file in `userData/`; no cloud, no migration; export/import is a Phase 4 add-on if requested |

## Default LLM composition (Phase 1 cordis.yml)

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      deepseek:
        apiKeyEnv: DEEPSEEK_API_KEY
        modelOverrides:
          deepseek-v4-pro:
            reasoningEfforts:
              off:
              high: high
      openai:
        apiKeyEnv: OPENAI_API_KEY
        modelOverrides:
          gpt-5:
            reasoningEfforts:
              off:
              high: high
      anthropic:
        apiKeyEnv: ANTHROPIC_API_KEY
        modelOverrides:
          claude-sonnet-4-5:
            reasoningEfforts:
              off:
              high: high
```

The settings panel writes extra routes under `llm-pi-ai.providers.<key>` in `$DSH_HOME/settings.yaml`; the base composition and the user layer merge per-provider, so adding a `custom:` route is additive, not replacing.

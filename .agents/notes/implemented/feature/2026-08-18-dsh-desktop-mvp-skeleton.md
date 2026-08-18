# Agent Note: `apps/desktop` MVP skeleton (dsh-desktop)

Status: implemented

## Problem

The DeepSeek Harness runtime ships as a Node-side service consumable by SDK clients over stdio JSON-RPC, but every official client is either a CLI (`dsh`) or a web app (`pnpm dsh web`); there is no desktop-native shell. Users who want a Claude-Desktop-style chat surface still have to drive a CLI or run a server.

A naive port — `npm create electron-app` plus a window plus `import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'` — works for a demo, but it is not sustainable as the first commit: the shell must be small enough to keep absorbing upstream `packages/*` changes without touching the desktop code, and the desktop's update cadence (weekly releases) must not require a fork-and-rewrite.

## Decision

`apps/desktop` is a thin Electron shell that talks to the harness exclusively through the JSON-RPC SDK wire contract. Its surface is 23 files, ~2000 lines, of which the runtime-touching code (`electron/main.ts` + `electron/preload.ts` + `cordis.yml`) is under 300 lines.

The harness child is the published `@deepseek-ai/dsh-sdk-jsonrpc-demo` bin spawned as a subprocess with `ELECTRON_RUN_AS_NODE=1`; the desktop calls into it through `@deepseek-ai/dsh-sdk-client`'s `HarnessClient`, which already owns the stdio JSON-RPC transport, the EOF → SIGTERM → SIGKILL teardown ladder, the per-session notification stream, and the request timeout. The shell re-implements none of these.

The desktop's own `cordis.yml` is a composition over the shipped spine (`@deepseek-ai/dsh-agent-spine-demo`) plus the multi-provider LLM adapter (`@deepseek-ai/dsh-llm-pi-ai` with three catalog routes — DeepSeek, OpenAI, Anthropic) plus SQLite session persistence (`@deepseek-ai/dsh-session-persistence-sqlite`), and a single explicit entry for `@deepseek-ai/dsh-sdk-jsonrpc-server` (the README of the demo bin warns that the bin serves nothing without this plugin — a fact a copy-from-headless-agent inevitably misses). The desktop holds the four env vars the child needs (`DSH_HOME`, `DSH_SESSIONS_DB_PATH`, `DSH_CORDIS_CONFIG`, and the per-route API key) in its own environment; the LLM adapter reads per-request, so a key set through the renderer's Settings dialog reaches the next request without restarting the child (after the desktop respawns it to pick up the new env).

Per-route API keys live in Electron `safeStorage` (the OS keychain on macOS, libsecret on Linux, DPAPI on Windows) under `<userData>/credentials.bin`. The Settings dialog exposes one field per catalog route. The renderer never imports `electron`; everything crosses the `contextIsolation` boundary through `window.dsh.*` defined in `electron/preload.ts`.

The desktop's TypeScript configuration is independent of the root `tsconfig.base.json`. The root base's `paths` map points workspace package names to `vendor/cordis/src` and friends, which forces `tsc` to typecheck vendored code under the harness's strict rules; the desktop extends a self-written base with the same strictness but no `paths` map, so workspace links resolve to each package's `lib/types/index.d.ts` (already built) instead of its source. This keeps the desktop typecheck isolated from any vendored strictness drift.

The desktop's workspace membership lists 24 `@deepseek-ai/dsh-*` packages — the four the renderer/main actually import, plus the 20 the `cordis.yml` references bare. pnpm's `linkWorkspacePackages: true` would only auto-link transitive workspace packages, and the harness child resolves bare plugin names against `apps/desktop/node_modules` (the loader does not walk to the monorepo root), so every `cordis.yml` reference must be a direct dependency. The set will grow with each `cordis.yml` edit, and the gate that catches the missing one is a startup failure with `Cannot find package '@deepseek-ai/dsh-X'` named in the stderr tail.

## Alternatives considered

**Why not a Tauri shell instead of Electron?** Tauri's smaller binary and Rust backend are attractive, but `@deepseek-ai/dsh-sdk-client` is a Node-only child-process client, and the desktop's whole value here is *not* writing new harness glue. Tauri would force a Rust IPC layer in front of the existing Node SDK with no real win — the bundled binary is the main differentiator and 80 MB vs 200 MB is not worth doubling the maintainer surface. Electron was picked because the JS stack matches the harness stack, and `contextBridge` is a familiar, hardened renderer boundary.

**Why not import harness internals from the renderer?** It would let the desktop reuse helpers like `SessionStore` directly and skip JSON-RPC framing for a fraction of the latency. It also makes the desktop a hard fork of every release: any internal rename, refactor, or extraction breaks the renderer, and the desktop would have to ship a release-locked harness build to keep working. The wire contract is the one stable seam; everything else in `packages/*` is fair game to refactor.

**Why not `@deepseek-ai/dsh-llm-deepseek` as the LLM plugin instead of `@deepseek-ai/dsh-llm-pi-ai`?** DeepSeek-only is one fewer dependency and matches the project's "official" framing, but it locks the shell to a single provider. The user explicitly asked for "support for various custom models" in this session, and `dsh-llm-pi-ai` already provides that surface (catalog routes for OpenAI and Anthropic, hand-declared routes for OpenAI-compatible gateways, per-request profile resolution, `/v1/models` probe through `registerModelDiscovery`). Picking the narrow plugin would have meant a Phase 1.5 rewrite to add `pi-ai`; picking the broad one is one entry in the composition and an extra `Settings` tab later.

**Why not the python SDK's `packaged-bin` single-executable runtime?** It is the right answer for distribution in Phase 3, where one self-contained binary matters, but it is a Python artifact and `apps/desktop` is a TypeScript Electron app. The TypeScript side uses `node bin.js` against the workspace-built `lib/bin.js`; the production switchover to `packaged-bin` is a Phase 3 packaging decision, not a Phase 1 one.

**Why not ship a "Settings: cwd picker" tab in Phase 1?** The current dialog sets keys, and `settings.lastCwd` defaults to `app.getPath('home')`. The picker is a follow-up: it is a 30-line IPC handler plus a button, and bundling it with this commit would have made review harder. The cwd persists in `<userData>/settings.json` and can be hand-edited today.

## Consequences

What the shell buys: a working desktop app that the user can launch, set a DeepSeek key, and send a message through the actual `deepseek-harness-sdk-runtime` — verified end-to-end in `apps/desktop/scripts/smoke.mjs` (initialize → `session/prompt` → event stream including `user/message`, `step/start`, and `session/title`).

What the shell gives up: every UI surface that isn't "settings + chat" — Markdown render, tool-call cards, multi-pane, subagent visualization, custom LLM provider management, multi-window, telemetry, code signing, auto-update. The PLAN.md's Phases 2-4 list them, and the dsh-llm-pi-ai choice already amortizes one of them (custom provider add/edit) into a settings-section write instead of a new plugin.

What the shell demands of upstream: any change to the wire protocol (new method, renamed field, type tightening) breaks the desktop; any change to a cordis.yml plugin's required config (`session-title`'s `fallbackMaxWords`, for example) requires updating `apps/desktop/cordis.yml` in the same change; any new plugin added to the composition requires listing it under `dependencies` in `apps/desktop/package.json`. The first is unavoidable and the whole point of the thin-shell design; the second and third are caught at startup with a clear stderr tail.

What the shell needs from CI: a follow-up lane that runs `apps/desktop/scripts/smoke.mjs` against the recorded harness and diffs the resulting event stream. The current script only asserts the wire is alive; a real snapshot would also pin the SDK's surface area.

# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

`agent-arcade` is a **zero-dependency Node CLI** that runs a small browser game while your
Claude Code agent works, and yanks you back the instant the agent needs you. Claude Code
hooks POST to a tiny local HTTP server; the game page polls that server's `/state` and
reacts. State machine:

```
working  → play; the "autonomous streak" timer climbs
waiting  → screen freezes, alarm, tab title flashes 🔔 — get back
done     → freeze, soft chime, shows streak + tool count
```

## Layout

| path | role |
|---|---|
| `bin/agent-arcade.js` | CLI entry — arg/flag parsing, the `start`/`install`/`verify`/`uninstall`/`help` subcommands, browser open, server ping. |
| `lib/server.js` | `createServer()` — the HTTP server + in-memory state machine. Serves everything under `public/` via a small static handler, plus `GET /state` and `POST /event/*`. |
| `lib/hooks.js` | The load-bearing installer: deep-merges our hooks into Claude Code `settings.json` without clobbering existing ones. `install` / `uninstall` / `inspect` / `buildHooks`. |
| `lib/gitignore.js` | Finds the git root and idempotently patches `.gitignore` on `install` (scope-dependent patterns). |
| `public/index.html` | The dashboard/picker. On load, redirects straight into the last-picked game via `localStorage["agent-arcade:lastGame"]` — unless the URL contains `pick`, which is the escape hatch back to the picker. |
| `public/shell.css` | Shared style tokens (dark terminal aesthetic) linked by every game page. |
| `public/shell.js` | Shared driver: HUD, pause/resume/restart overlay, WebAudio chimes, tab-title flashing, and the `/state` poll loop. Reads only the `agent` field and drives whatever `Game` object the page defines. |
| `public/games/*.html` | The 5 games — `snake.html`, `dino.html`, `breakout.html`, `pong.html`, `2048.html`. Each is a self-contained page implementing a small `Game` object contract that `shell.js` drives. |
| `test/smoke.js` | Zero-dep `node:test` smoke tests for the server + installer. |

Relative paths matter: `bin/agent-arcade.js` requires `../lib/*`, and `lib/server.js`
serves files from `../public/` (extension allow-list of `.html`/`.js`/`.css`, plus a
path-traversal guard) rather than one hardcoded file. Keep the `bin/lib/public` layout —
`package.json` `bin` and `files` depend on it.

## Adding a 6th game

- Drop `public/games/<name>.html` implementing the `Game` contract: `reset` and `draw` are
  required; `step`, `input`, `overTitle`, `overBody`, `won` are optional; `alive` and
  `score` are required.
- Link `../shell.css` and `../shell.js` — don't reimplement the HUD/overlay/audio/poll loop.
- Add one card to the dashboard grid in `public/index.html` with a matching `id`.
- Add that same `id` to the `KNOWN` array near the top of `public/index.html` — it gates
  the "remembers your pick" auto-redirect; a card that works but is missing from `KNOWN`
  will never auto-launch on a returning visit and silently falls through to the picker
  every time.

## Commands

```bash
npm start              # node bin/agent-arcade.js  (start server + open game)
npm start -- --no-open # start without opening the browser
npm run sim            # simulate a fake agent session — try the game with no hooks
npm test               # node --test  (runs test/smoke.js)

node bin/agent-arcade.js simulate               # auto walkthrough (working→waiting→done→idle)
node bin/agent-arcade.js simulate --loop        # repeat the walkthrough
node bin/agent-arcade.js simulate --interactive # drive events by key: w/t/n/s/i

node bin/agent-arcade.js install    # merge hooks into Claude Code settings
node bin/agent-arcade.js verify     # confirm hooks present, JSON valid, server live
node bin/agent-arcade.js uninstall  # remove only the hooks we added
```

## Hook → endpoint map

| Claude Code hook | command | effect |
|---|---|---|
| `UserPromptSubmit` | `agent-arcade hook working` (default) → `POST /event/working` | **auto-launch**: ensure server up + open game once on cold start, then start a round, reset tool count. With `install --no-autostart` it's the old bare `curl /event/working`. |
| `PreToolUse` | `curl POST /event/tool` | +1 tool, stay live |
| `Notification` | `curl POST /event/waiting` | yank back + show the message |
| `Stop` | `curl POST /event/done` | freeze + chime |

`agent-arcade hook <event>` (in `bin/agent-arcade.js`, function `runHook`) is the
self-bootstrapping entry the installed `UserPromptSubmit` hook calls: if the server is live it
just posts; on a cold start it spawns a **detached** server, opens the browser once, waits for it,
then posts `working`. Only `UserPromptSubmit` uses it — the other three stay fast curls because by
the time they fire the server is already up.

## Conventions — keep these intact

- **Zero runtime dependencies.** Node ≥18, CommonJS, `"use strict"`. Use only the standard
  library (`http`, `fs`, `os`, `path`, `child_process`). Don't add deps; tests use built-in
  `node:test`.
- **Ownership marker.** Every hook command the installer writes ends with a `#agent-arcade`
  shell comment. That marker is how `install` updates in place (no duplicates) and
  `uninstall` removes *only* our entries. Don't drop it.
- **The settings footgun.** Since claude-code v1.0.95, *any* invalid `settings.json`
  silently disables **all** hooks in that file. So the installer only writes schema-valid
  entries and backs up to `*.bak` before any write. After changing hook-writing code, run
  `verify` and the in-app `/hooks` check.
- **Install scopes.** Default is the personal, gitignored `./.claude/settings.local.json`
  (`--global` → `~/.claude/settings.json`, `--shared` → committed `./.claude/settings.json`).
  For `local`/`shared`, `install` also ensures the repo `.gitignore` covers the settings
  file and `.bak` backup it writes (pass `--no-gitignore` to skip). `uninstall` does not
  remove those ignore entries.

## Note on `.claude/settings.json`

The committed `.claude/settings.json` holds **permissions only** — deliberately no arcade
hooks. The project's philosophy (see README) is that hooks live in the gitignored local
scope so installing doesn't push a game onto teammates. To dogfood locally, run
`node bin/agent-arcade.js install` (writes to the gitignored `settings.local.json`).

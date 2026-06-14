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
| `lib/server.js` | `createServer()` — the HTTP server + in-memory state machine. Serves `public/index.html`, `GET /state`, `POST /event/*`. |
| `lib/hooks.js` | The load-bearing installer: deep-merges our hooks into Claude Code `settings.json` without clobbering existing ones. `install` / `uninstall` / `inspect` / `buildHooks`. |
| `public/index.html` | The game UI. Polls `/state` and reads only the `agent` field, so the game can be swapped freely. |
| `test/smoke.js` | Zero-dep `node:test` smoke tests for the server + installer. |

Relative paths matter: `bin/agent-arcade.js` requires `../lib/*`, and `lib/server.js`
reads `../public/index.html`. Keep the `bin/lib/public` layout — `package.json` `bin` and
`files` depend on it.

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

| Claude Code hook | endpoint | effect |
|---|---|---|
| `UserPromptSubmit` | `POST /event/working` | start a round, reset tool count |
| `PreToolUse` | `POST /event/tool` | +1 tool, stay live |
| `Notification` | `POST /event/waiting` | yank back + show the message |
| `Stop` | `POST /event/done` | freeze + chime |

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

## Note on `.claude/settings.json`

The committed `.claude/settings.json` holds **permissions only** — deliberately no arcade
hooks. The project's philosophy (see README) is that hooks live in the gitignored local
scope so installing doesn't push a game onto teammates. To dogfood locally, run
`node bin/agent-arcade.js install` (writes to the gitignored `settings.local.json`).

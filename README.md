# agent-arcade

**Play a game while your Claude Code agent works — that yanks you back the instant it needs you.**

```
working  → play Snake; your "autonomous streak" timer climbs
waiting  → screen freezes, alarm chimes, tab title flashes 🔔 — get back
done     → freeze, soft chime, shows your streak + tool count
```

Zero dependencies. Pure Node — which you already have, since Claude Code runs on it.

## Quick start

```bash
npx agent-arcade install     # wire the hooks into Claude Code (no hand-editing JSON)
# restart Claude Code so it reloads hooks, then just send a prompt —
# the game starts itself and opens in your browser. No separate `start` needed.
```

Auto-launch is on by default: your first prompt boots the server and opens the game tab, then
later prompts reuse it. To confirm the wiring (and see the live server), run
`npx agent-arcade verify`. Prefer to start the server yourself? Install with `--no-autostart` and
run `npx agent-arcade` before prompting.

No npm publish yet? Run straight from the repo:

```bash
npx github:gonshi10/agent-arcade install
```

## Commands

| command | what it does |
|---|---|
| `npx agent-arcade [start]` | start the server + open the game |
| `npx agent-arcade simulate` | start + drive a fake agent session — try the game with no hooks installed |
| `npx agent-arcade install` | merge the hooks into Claude Code settings |
| `npx agent-arcade verify` | check hooks are present, JSON is valid, server is up |
| `npx agent-arcade uninstall` | remove **only** the hooks we added |
| `npx agent-arcade help` | flags + usage |

## Flags

| flag | effect |
|---|---|
| `--port <n>` | port for server **and** installed hooks (default `4317`) |
| `--precise` | narrow `Notification` to `permission_prompt` + `idle_prompt` (less noise) |
| `--no-autostart` | (`install`) don't auto-launch the game on prompt; start the server yourself. Default: auto-launch on |
| `--no-gitignore` | (`install`) don't patch the repo `.gitignore` with local artifacts |
| `--global` | write to `~/.claude/settings.json` (all projects) |
| `--shared` | write to `./.claude/settings.json` (committed to the repo) |
| *(default)* | `./.claude/settings.local.json` — personal, gitignored |
| `--no-open` | don't auto-open the browser on `start` / `simulate` |
| `--interactive` | (`simulate`) drive events by key — `w`/`t`/`n`/`s`/`i` — instead of the auto walkthrough |
| `--loop` | (`simulate`) repeat the auto walkthrough until Ctrl-C |

Default scope is the **personal, gitignored** settings file so installing doesn't
push a game onto your teammates.

## How the state machine works

| Claude Code hook | endpoint | game effect |
|---|---|---|
| `UserPromptSubmit` | `/event/working` | start a round |
| `PreToolUse` | `/event/tool` | +1 tool, stay live |
| `Notification` | `/event/waiting` | **yank back** + show the message |
| `Stop` | `/event/done` | freeze + chime |

Each hook fires with a 1s timeout and `|| true`, so if the server's off it
silently no-ops and can never stall your agent.

## Safe by design

`install` deep-merges and **never touches your existing hooks**. Every command it
adds carries a `#agent-arcade` marker, so re-running updates in place (no
duplicates) and `uninstall` removes exactly those and nothing else. Your file is
backed up to `*.bak` before any write. For repo-local scopes (`local` and
`shared`), `install` also idempotently patches the git root's `.gitignore` so
the settings file and backup stay untracked — use `--no-gitignore` to skip that.

> ⚠ **The footgun this guards against:** since claude-code v1.0.95, *any* invalid
> `settings.json` silently disables **all** hooks in that file. agent-arcade only
> writes schema-valid entries — but always run `npx agent-arcade verify` and the
> in-app `/hooks` check after installing, so you catch breakage from *any* source.

## On the `Notification` matcher (the load-bearing hook)

`Notification` is the "needs you" signal, and its exact firing has varied across
Claude Code versions. The default matcher is `""` (empty) — canonical, always
valid, and fires on every notification, so the yank-back is reliable. If that's
too noisy, `--precise` narrows it to `permission_prompt` + `idle_prompt`.

Quick test without running the agent:

```bash
npx agent-arcade --no-open &
curl -X POST localhost:4317/event/waiting -d '{"message":"test"}'
# the page should flip to the red "needs you" overlay
```

## Roadmap

- forward `PostToolUse` tool names → each tool spawns a themed pellet
- swap Snake for any game (the page only reads the `agent` field from `/state`)
- `SessionStart` → `/event/idle` reset between sessions

## License

MIT

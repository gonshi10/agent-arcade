"use strict";
/**
 * Hook spec + the load-bearing installer logic: merge our hooks into the user's
 * Claude Code settings WITHOUT clobbering theirs, idempotently, removably.
 *
 * Ownership marker: every injected command ends with a `#agent-arcade` shell
 * comment, so we can find / update / remove ONLY our entries.
 *
 * ⚠ Since claude-code v1.0.95, ANY invalid settings.json silently disables all
 * hooks. We only ever write schema-valid entries, back up before writing, and
 * ship a `verify` command to catch breakage.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const MARKER = "#agent-arcade";
const EVENTS = ["UserPromptSubmit", "PreToolUse", "Notification", "Stop"];

/**
 * Build the hook entries pointed at `port`.
 * precise=false (default): Notification uses matcher "" — canonical, always
 *   valid, fires on every notification (reliable yank-back).
 * precise=true: Notification narrows to permission_prompt + idle_prompt to cut
 *   noise (requires a Claude Code version that validates those matcher values).
 */
function buildHooks(port, { precise = false } = {}) {
  const base = `http://localhost:${port}/event`;
  const c = (ep, extra = "") =>
    `curl -s -m 1 -X POST ${base}/${ep} ${extra}>/dev/null 2>&1 || true ${MARKER}`.replace(
      / +/g,
      " "
    );
  const waitCmd = () =>
    c("waiting", "-H 'Content-Type: application/json' -d @- ");

  const Notification = precise
    ? [
        { matcher: "permission_prompt", hooks: [{ type: "command", command: waitCmd() }] },
        { matcher: "idle_prompt", hooks: [{ type: "command", command: waitCmd() }] },
      ]
    : [{ matcher: "", hooks: [{ type: "command", command: waitCmd() }] }];

  return {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: c("working") }] }],
    PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: c("tool") }] }],
    Notification,
    Stop: [{ hooks: [{ type: "command", command: c("done") }] }],
  };
}

function isOurs(entry) {
  return (
    entry &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some(
      (h) => typeof h.command === "string" && h.command.includes(MARKER)
    )
  );
}

function resolveSettingsPath({ scope = "local", cwd = process.cwd() } = {}) {
  if (scope === "global")
    return path.join(os.homedir(), ".claude", "settings.json");
  if (scope === "shared") return path.join(cwd, ".claude", "settings.json");
  return path.join(cwd, ".claude", "settings.local.json"); // personal, gitignored
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error(
      `Could not parse ${file} as JSON — refusing to touch it. (${e.message})`
    );
    err.fatal = true;
    throw err;
  }
}

function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function install({ port = 4317, scope = "local", cwd = process.cwd(), precise = false } = {}) {
  const file = resolveSettingsPath({ scope, cwd });
  const settings = readSettings(file);
  const backedUp = fs.existsSync(file);

  settings.hooks = settings.hooks || {};
  const ours = buildHooks(port, { precise });

  for (const [event, entries] of Object.entries(ours)) {
    const existing = Array.isArray(settings.hooks[event])
      ? settings.hooks[event]
      : [];
    const kept = existing.filter((e) => !isOurs(e)); // drop prior agent-arcade entries
    settings.hooks[event] = kept.concat(entries);
  }

  writeSettings(file, settings);
  return { file, backedUp, precise };
}

function uninstall({ scope = "local", cwd = process.cwd() } = {}) {
  const file = resolveSettingsPath({ scope, cwd });
  if (!fs.existsSync(file)) return { file, removed: 0 };

  const settings = readSettings(file);
  let removed = 0;
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      const arr = settings.hooks[event];
      if (!Array.isArray(arr)) continue;
      const kept = arr.filter((e) => {
        const mine = isOurs(e);
        if (mine) removed++;
        return !mine;
      });
      if (kept.length) settings.hooks[event] = kept;
      else delete settings.hooks[event];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  writeSettings(file, settings);
  return { file, removed };
}

/** Inspect all three scopes: where our hooks live, JSON validity, port. */
function inspect({ cwd = process.cwd() } = {}) {
  return ["local", "shared", "global"].map((scope) => {
    const file = resolveSettingsPath({ scope, cwd });
    const r = { scope, file, exists: fs.existsSync(file), valid: null, events: [], port: null, error: null };
    if (!r.exists) return r;
    try {
      const s = readSettings(file);
      r.valid = true;
      if (s.hooks) {
        for (const [ev, arr] of Object.entries(s.hooks)) {
          if (Array.isArray(arr) && arr.some(isOurs)) {
            r.events.push(ev);
            for (const e of arr)
              for (const h of e.hooks || []) {
                const m = /localhost:(\d+)\/event/.exec(h.command || "");
                if (m) r.port = +m[1];
              }
          }
        }
      }
    } catch (e) {
      r.valid = false;
      r.error = e.message;
    }
    return r;
  });
}

module.exports = {
  MARKER,
  EVENTS,
  buildHooks,
  resolveSettingsPath,
  install,
  uninstall,
  inspect,
  readSettings,
};

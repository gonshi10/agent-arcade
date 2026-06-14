#!/usr/bin/env node
"use strict";
const http = require("http");
const { exec } = require("child_process");
const { createServer } = require("../lib/server");
const hooks = require("../lib/hooks");

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("-")) || "start";
const flag = (n) => argv.includes("--" + n);
const opt = (n, d) => {
  const i = argv.indexOf("--" + n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const scopeFromFlags = () =>
  flag("global") ? "global" : flag("shared") ? "shared" : "local";
const PORT = parseInt(opt("port", "4317"), 10);

function openBrowser(url) {
  const c =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(c, () => {});
}

function scopeLabel(s) {
  return s === "global"
    ? "global (~/.claude/settings.json)"
    : s === "shared"
    ? "shared, committed (.claude/settings.json)"
    : "personal, gitignored (.claude/settings.local.json)";
}

function pingServer(port, cb) {
  const req = http.get(
    { host: "127.0.0.1", port, path: "/state", timeout: 800 },
    (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          cb(true, JSON.parse(d));
        } catch {
          cb(false, null);
        }
      });
    }
  );
  req.on("error", () => cb(false, null));
  req.on("timeout", () => {
    req.destroy();
    cb(false, null);
  });
}

function help() {
  console.log(`
agent-arcade — play a game while your Claude Code agent works.

Usage:
  npx agent-arcade [start]        Start the server + open the game
  npx agent-arcade install        Add the hooks to Claude Code settings
  npx agent-arcade verify         Check hooks are installed, valid, and live
  npx agent-arcade uninstall      Remove only the hooks we added
  npx agent-arcade help

Flags:
  --port <n>     Port (default 4317). Used by server AND installed hooks.
  --precise      Narrow Notification to permission_prompt + idle_prompt
                 (less noise; needs a Claude Code version that validates them).
                 Default is the safe, always-valid empty matcher.
  --global       Target ~/.claude/settings.json (all projects)
  --shared       Target ./.claude/settings.json (committed to the repo)
                 default: ./.claude/settings.local.json (personal, gitignored)
  --no-open      Don't auto-open the browser on start

First run:
  npx agent-arcade install
  # restart Claude Code, then:
  npx agent-arcade verify
  npx agent-arcade
`);
}

if (cmd === "help" || flag("help") || flag("h")) {
  help();
  process.exit(0);
}

if (cmd === "install") {
  try {
    const scope = scopeFromFlags();
    const { file, backedUp, precise } = hooks.install({
      port: PORT,
      scope,
      precise: flag("precise"),
    });
    console.log(`✓ Installed agent-arcade hooks → ${scopeLabel(scope)}`);
    console.log(`  ${file}${backedUp ? "  (backup: .bak)" : ""}`);
    console.log(`  Port ${PORT}  ·  Notification matcher: ${precise ? "permission_prompt + idle_prompt" : "all (empty)"}`);
    console.log(`\n→ Restart Claude Code, then run:  npx agent-arcade verify`);
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }
} else if (cmd === "uninstall") {
  try {
    const { file, removed } = hooks.uninstall({ scope: scopeFromFlags() });
    console.log(
      removed
        ? `✓ Removed ${removed} agent-arcade hook(s) from ${file}`
        : `· No agent-arcade hooks found in ${file}`
    );
  } catch (e) {
    console.error("✗ " + e.message);
    process.exit(1);
  }
} else if (cmd === "verify") {
  const report = hooks.inspect({});
  let anyHooks = false,
    anyInvalid = false,
    foundPort = null;
  console.log("Settings files:");
  for (const r of report) {
    const tag = r.scope.padEnd(7);
    if (!r.exists) {
      console.log(`  ·  ${tag} (no file)             ${r.file}`);
    } else if (r.valid === false) {
      anyInvalid = true;
      console.log(`  ✗  ${tag} INVALID JSON           ${r.file}`);
      console.log(`        ${r.error}`);
      console.log(`        ⚠ invalid settings DISABLE ALL hooks in this file.`);
    } else if (r.events.length) {
      anyHooks = true;
      foundPort = r.port || foundPort;
      console.log(`  ✓  ${tag} ${r.events.join(", ")}  (port ${r.port})`);
      console.log(`        ${r.file}`);
    } else {
      console.log(`  ·  ${tag} no agent-arcade hooks   ${r.file}`);
    }
  }
  if (anyHooks) {
    const missing = hooks.EVENTS.filter(
      (e) => !report.some((r) => r.events.includes(e))
    );
    if (missing.length)
      console.log(`\n⚠ Missing expected events: ${missing.join(", ")} — re-run install.`);
  } else if (!anyInvalid) {
    console.log(`\nNo agent-arcade hooks found. Run:  npx agent-arcade install`);
  }

  const port = foundPort || PORT;
  pingServer(port, (alive, state) => {
    console.log(
      alive
        ? `\n✓ Server up on ${port}  (agent: ${state.agent})`
        : `\n·  Server not running on ${port}. Start it:  npx agent-arcade${port !== 4317 ? " --port " + port : ""}`
    );
    console.log(`\nFinal check — inside Claude Code run  /hooks  and confirm`);
    console.log(`UserPromptSubmit · PreToolUse · Notification · Stop are listed.`);
    console.log(`(If they're missing, Claude Code rejected the settings — fix JSON, reinstall.)`);
  });
} else if (cmd === "start") {
  const server = createServer();
  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Agent Arcade → ${url}  (Ctrl-C to stop)`);
    if (!flag("no-open")) openBrowser(url);
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE")
      console.error(`✗ Port ${PORT} is in use. Try --port <n>.`);
    else console.error("✗ " + e.message);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${cmd}`);
  help();
  process.exit(1);
}

#!/usr/bin/env node
"use strict";
const http = require("http");
const https = require("https");
const { exec, spawn } = require("child_process");
const CURRENT = require("../package.json").version;
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

function postEvent(port, name, body, cb) {
  const payload = body ? JSON.stringify(body) : "";
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/event/" + name,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    },
    (res) => {
      res.resume();
      res.on("end", () => cb && cb(true));
    }
  );
  req.on("error", () => cb && cb(false));
  req.end(payload);
}

// Fetch the latest published version from the npm registry. The /latest endpoint
// returns a slim manifest; we only read `.version`. Never throws — any
// network/parse/timeout error comes back through `cb(err)`.
function fetchLatestVersion(cb) {
  const req = https.get(
    {
      host: "registry.npmjs.org",
      path: "/agent-arcade/latest",
      timeout: 3000,
      headers: { Accept: "application/json" },
    },
    (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const v = JSON.parse(d).version;
          if (!v) throw new Error("no version in registry response");
          cb(null, v);
        } catch (e) {
          cb(e);
        }
      });
    }
  );
  req.on("error", cb);
  req.on("timeout", () => {
    req.destroy();
    cb(new Error("timed out"));
  });
}

// True if version `a` is strictly greater than `b`. Zero-dep semver-lite: compares
// the three numeric segments; any `-prerelease` suffix is dropped, so `1.2.0-rc.1`
// is treated as `1.2.0` (fine for this CLI's needs).
function semverGt(a, b) {
  const parse = (v) =>
    String(v).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// Self-bootstrapping hook entry: ensure the server is up, then post `event`.
// If the server is already live we just post (no new browser tab). On a cold
// start we spawn a detached background server, open the game once, wait for it
// to answer, then post. Must stay fast and never throw — UserPromptSubmit blocks
// the prompt until this returns.
function runHook(port, event) {
  pingServer(port, (alive, state) => {
    if (alive) {
      // Server's up but no tab is watching (closed/never opened) — reopen the game.
      if (state && !state.watched) openBrowser(`http://localhost:${port}`);
      return postEvent(port, event, null, () => process.exit(0));
    }

    // Cold start: detached server survives this short-lived process.
    try {
      spawn(process.execPath, [__filename, "start", "--no-open", "--port", String(port), "--state", event], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } catch {
      return process.exit(0);
    }
    openBrowser(`http://localhost:${port}`);

    let tries = 0;
    (function waitUp() {
      pingServer(port, (up) => {
        if (up) return postEvent(port, event, null, () => process.exit(0));
        if (++tries >= 10) return process.exit(0); // ~2s max, give up quietly
        setTimeout(waitUp, 200);
      });
    })();
  });
}

// Drive the server through a realistic agent lifecycle so you can watch the
// game react — no Claude Code hooks or real session required.
function runWalkthrough(port, { loop }) {
  const timeline = [
    { delay: 0, event: "working", log: "working   prompt sent — play!" },
    { delay: 1500, event: "tool", log: "tool ×1   streak climbing" },
    { delay: 1500, event: "tool", log: "tool ×2" },
    { delay: 1500, event: "tool", log: "tool ×3" },
    {
      delay: 2000,
      event: "waiting",
      body: { message: "Approve edit to lib/server.js?" },
      log: 'waiting   🔔 "Approve edit to lib/server.js?"',
    },
    { delay: 4000, event: "working", log: "working   resumed — tools reset" },
    { delay: 1500, event: "tool", log: "tool ×1" },
    { delay: 1500, event: "tool", log: "tool ×2" },
    { delay: 2000, event: "done", log: "done      ✓ turn complete" },
    { delay: 3500, event: "idle", log: "idle      back to waiting for a prompt" },
  ];

  let i = 0;
  function next() {
    if (i >= timeline.length) {
      if (loop) return setTimeout(() => ((i = 0), next()), 1500);
      console.log("\n· Walkthrough done. Server still up — Ctrl-C to stop.");
      return;
    }
    const step = timeline[i++];
    setTimeout(() => {
      postEvent(port, step.event, step.body, (ok) =>
        console.log(`  ${ok ? "→" : "✗"} ${step.log}`)
      );
      next();
    }, step.delay);
  }
  console.log("Driving an auto walkthrough" + (loop ? " (looping)" : "") + ":");
  next();
}

// Manual control: press a key, fire an event.
function runInteractive(port, server) {
  const map = {
    w: ["working", null, "working"],
    t: ["tool", null, "tool +1"],
    n: ["waiting", { message: "Agent needs your input" }, "waiting 🔔"],
    s: ["done", null, "done ✓"],
    i: ["idle", null, "idle"],
  };
  console.log(
    "\nInteractive — drive the agent yourself:\n" +
      "  [w]orking  [t]ool  [n]eeds-you  [s]top/done  [i]dle  [q]uit\n"
  );
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  function quit() {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    server.close(() => process.exit(0));
  }
  stdin.on("data", (key) => {
    if (key === "q" || key === "") return quit(); // q or Ctrl-C
    const m = map[key];
    if (!m) return;
    postEvent(port, m[0], m[1], (ok) => console.log(`  ${ok ? "→" : "✗"} ${m[2]}`));
  });
}

function help() {
  console.log(`
agent-arcade — play a game while your Claude Code agent works.

Usage:
  npx agent-arcade [start]        Start the server + open the game
  npx agent-arcade simulate       Start + drive a fake agent session (try it, no hooks)
  npx agent-arcade install        Add the hooks to Claude Code settings
  npx agent-arcade verify         Check hooks are installed, valid, and live
  npx agent-arcade uninstall      Remove only the hooks we added
  npx agent-arcade update         Check npm and upgrade to the latest version
  npx agent-arcade help

  (npx agent-arcade hook <event>  internal — run by the installed prompt hook)

Flags:
  --port <n>      Port (default 4317). Used by server AND installed hooks.
  --interactive   (simulate) Drive events by key: w/t/n/s/i — instead of auto.
  --loop          (simulate) Repeat the auto walkthrough until Ctrl-C.
  --precise       Narrow Notification to permission_prompt + idle_prompt
                  (less noise; needs a Claude Code version that validates them).
                  Default is the safe, always-valid empty matcher.
  --no-autostart  (install) Don't auto-launch the game on prompt; assume you
                  started the server yourself. Default: auto-launch is on.
  --global        Target ~/.claude/settings.json (all projects)
  --shared        Target ./.claude/settings.json (committed to the repo)
                  default: ./.claude/settings.local.json (personal, gitignored)
  --no-open       Don't auto-open the browser on start

First run:
  npx agent-arcade install
  # restart Claude Code, then just send a prompt — the game launches itself.
  # (auto-launch is on by default; check anytime with: npx agent-arcade verify)
`);
}

if (cmd === "help" || flag("help") || flag("h")) {
  help();
  process.exit(0);
}

if (cmd === "install") {
  try {
    const scope = scopeFromFlags();
    const { file, backedUp, precise, autostart } = hooks.install({
      port: PORT,
      scope,
      precise: flag("precise"),
      autostart: !flag("no-autostart"),
    });
    console.log(`✓ Installed agent-arcade hooks → ${scopeLabel(scope)}`);
    console.log(`  ${file}${backedUp ? "  (backup: .bak)" : ""}`);
    console.log(`  Port ${PORT}  ·  Notification matcher: ${precise ? "permission_prompt + idle_prompt" : "all (empty)"}`);
    console.log(`  Auto-launch on prompt: ${autostart ? "on (game opens itself)" : "off (start the server yourself)"}`);
    console.log(`\n→ Restart Claude Code, then ${autostart ? "just send a prompt — the game launches itself." : "run:  npx agent-arcade"}`);
    console.log(`  (Check anytime with:  npx agent-arcade verify)`);
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
} else if (cmd === "update") {
  fetchLatestVersion((err, latest) => {
    if (err) {
      console.log(`·  Couldn't reach npm (${err.message}). You're on v${CURRENT}.`);
      process.exit(0);
    }
    if (!semverGt(latest, CURRENT)) {
      console.log(`✓ Already up to date (v${CURRENT}).`);
      process.exit(0);
    }
    console.log(`Updating v${CURRENT} → v${latest} …\n`);
    const npm = spawn("npm", ["install", "-g", "agent-arcade@" + latest], {
      stdio: "inherit",
    });
    npm.on("error", (e) => {
      console.error(`✗ Couldn't run npm: ${e.message}`);
      process.exit(1);
    });
    npm.on("close", (code) => {
      if (code === 0) {
        console.log(`\n✓ Updated to v${latest}.`);
        process.exit(0);
      }
      console.error(
        `\n✗ npm exited with code ${code}. If it's a permissions error, ` +
          `re-run with the rights to install globally.`
      );
      process.exit(1);
    });
  });
} else if (cmd === "hook") {
  // Internal: invoked by the installed UserPromptSubmit hook.
  const event = argv.find((a) => !a.startsWith("-") && a !== "hook") || "working";
  runHook(PORT, event);
} else if (cmd === "simulate" || cmd === "sim") {
  const server = createServer();
  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://localhost:${PORT}`;
    const interactive = flag("interactive");
    console.log(`Agent Arcade → ${url}  (Ctrl-C to stop)`);
    console.log(`Simulating events — no Claude Code hooks needed.\n`);
    if (!flag("no-open")) openBrowser(url);
    if (interactive) runInteractive(PORT, server);
    else runWalkthrough(PORT, { loop: flag("loop") });
  });
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE")
      console.error(`✗ Port ${PORT} is in use. Try --port <n>.`);
    else console.error("✗ " + e.message);
    process.exit(1);
  });
} else if (cmd === "start") {
  // --state seeds the initial agent state. The cold-start server the prompt hook
  // spawns boots straight into `working`, so the open tab shows the game even if
  // the follow-up `working` POST is slow or dropped.
  const server = createServer({ initialAgent: opt("state", null) });
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

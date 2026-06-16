"use strict";
/**
 * Zero-dependency smoke tests using Node's built-in test runner (node:test).
 * Run with:  npm test   (= node --test test/)
 *
 * Covers the two load-bearing pieces:
 *   1. lib/server.js  — the working/waiting/done state machine over HTTP
 *   2. lib/hooks.js   — idempotent, non-clobbering install / uninstall
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const { createServer } = require("../lib/server");
const hooks = require("../lib/hooks");

const BIN = path.join(__dirname, "..", "bin", "agent-arcade.js");

// --- tiny HTTP helpers -------------------------------------------------------

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: urlPath },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })
        );
      }
    );
    req.on("error", reject);
    if (body != null) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

function withServer(fn) {
  return async () => {
    const server = createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      await fn(port);
    } finally {
      await new Promise((r) => server.close(r));
    }
  };
}

// --- 1. server state machine -------------------------------------------------

test("working resets tools and sets agent", withServer(async (port) => {
  await request(port, "POST", "/event/working");
  const { status, body } = await request(port, "GET", "/state");
  assert.equal(status, 200);
  assert.equal(body.agent, "working");
  assert.equal(body.tools, 0);
}));

test("tool bumps the counter, stays working", withServer(async (port) => {
  await request(port, "POST", "/event/working");
  await request(port, "POST", "/event/tool");
  const { body } = await request(port, "GET", "/state");
  assert.equal(body.agent, "working");
  assert.equal(body.tools, 1);
}));

test("waiting extracts the message into reason", withServer(async (port) => {
  await request(port, "POST", "/event/waiting", { message: "needs you" });
  const { body } = await request(port, "GET", "/state");
  assert.equal(body.agent, "waiting");
  assert.equal(body.reason, "needs you");
}));

test("waiting falls back to a default reason", withServer(async (port) => {
  await request(port, "POST", "/event/waiting", {});
  const { body } = await request(port, "GET", "/state");
  assert.equal(body.agent, "waiting");
  assert.ok(body.reason.length > 0);
}));

test("done sets agent to done", withServer(async (port) => {
  await request(port, "POST", "/event/done");
  const { body } = await request(port, "GET", "/state");
  assert.equal(body.agent, "done");
}));

test("unknown event returns 404", withServer(async (port) => {
  const { status } = await request(port, "POST", "/event/nope");
  assert.equal(status, 404);
}));

test("only ?watch=1 polls mark the game as watched", withServer(async (port) => {
  // Plain /state (the CLI's liveness ping) must NOT count as a watcher.
  const ping = await request(port, "GET", "/state");
  assert.equal(ping.body.watched, false, "bare /state should not mark watched");

  // A real browser poll carries ?watch=1.
  const watch = await request(port, "GET", "/state?watch=1");
  assert.equal(watch.body.watched, true, "?watch=1 should mark watched");

  // The tab closing flips it back immediately.
  await request(port, "POST", "/event/closed");
  const after = await request(port, "GET", "/state");
  assert.equal(after.body.watched, false, "/event/closed should clear watched");
}));

test("createServer seeds the initial agent state (cold-start working)", async () => {
  // The prompt hook cold-starts the server with --state working so the open tab
  // shows the game even if the follow-up `working` POST never lands.
  const server = createServer({ initialAgent: "working" });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const { body } = await request(port, "GET", "/state");
    assert.equal(body.agent, "working", "seeded agent should be working");
    assert.equal(body.tools, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- 1b. buildHooks: auto-launch UserPromptSubmit ----------------------------

test("UserPromptSubmit auto-launches by default (node hook working)", () => {
  const cmd = hooks.buildHooks(4317).UserPromptSubmit[0].hooks[0].command;
  assert.match(cmd, /hook working/, "should invoke the self-bootstrapping hook");
  assert.match(cmd, /bin[/\\]agent-arcade\.js/, "should use an absolute bin path");
  assert.match(cmd, /--port 4317/, "should pass the port through");
  assert.ok(cmd.includes(hooks.MARKER), "must keep the ownership marker");
});

test("--no-autostart reverts UserPromptSubmit to the bare curl", () => {
  const cmd = hooks.buildHooks(4317, { autostart: false }).UserPromptSubmit[0].hooks[0].command;
  assert.match(cmd, /curl .*\/event\/working/, "should be the bare-curl form");
  assert.doesNotMatch(cmd, /hook working/);
  assert.ok(cmd.includes(hooks.MARKER), "must keep the ownership marker");
});

test("hook posts to an already-running server (no cold start)", withServer(async (port) => {
  await new Promise((resolve, reject) =>
    execFile(process.execPath, [BIN, "hook", "working", "--port", String(port)], (err) =>
      err ? reject(err) : resolve()
    )
  );
  const { body } = await request(port, "GET", "/state");
  assert.equal(body.agent, "working");
}));

// --- 2. installer: idempotent, non-clobbering --------------------------------

function tmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-arcade-test-"));
}

test("install is idempotent and preserves foreign hooks", () => {
  const cwd = tmpCwd();
  const file = hooks.resolveSettingsPath({ scope: "shared", cwd });

  // Pre-seed a foreign hook the installer must never touch.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { matcher: "", hooks: [{ type: "command", command: "echo mine" }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [foreign] } }, null, 2));

  hooks.install({ scope: "shared", cwd });
  hooks.install({ scope: "shared", cwd }); // second run must not duplicate

  const s = hooks.readSettings(file);
  for (const event of hooks.EVENTS) {
    const ours = s.hooks[event].filter((e) =>
      e.hooks.some((h) => h.command.includes(hooks.MARKER))
    );
    assert.equal(ours.length, 1, `${event} should have exactly one agent-arcade entry`);
  }
  // Foreign hook survived.
  assert.ok(
    s.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === "echo mine")),
    "foreign PreToolUse hook must be preserved"
  );
  // Backup written on the second write.
  assert.ok(fs.existsSync(file + ".bak"), "a .bak backup should exist");

  fs.rmSync(cwd, { recursive: true, force: true });
});

test("uninstall removes only ours and prunes empty events", () => {
  const cwd = tmpCwd();
  const file = hooks.resolveSettingsPath({ scope: "shared", cwd });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const foreign = { matcher: "", hooks: [{ type: "command", command: "echo mine" }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [foreign] } }, null, 2));

  hooks.install({ scope: "shared", cwd });
  const { removed } = hooks.uninstall({ scope: "shared", cwd });
  assert.ok(removed >= hooks.EVENTS.length, "should remove our entries");

  const s = hooks.readSettings(file);
  // Foreign hook still there; our entries gone; events with only ours removed.
  assert.ok(s.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === "echo mine")));
  assert.ok(!("Stop" in s.hooks), "Stop had only our hook and should be pruned");
  for (const event of Object.keys(s.hooks)) {
    for (const e of s.hooks[event]) {
      assert.ok(
        !e.hooks.some((h) => h.command.includes(hooks.MARKER)),
        `no agent-arcade hooks should remain in ${event}`
      );
    }
  }

  fs.rmSync(cwd, { recursive: true, force: true });
});

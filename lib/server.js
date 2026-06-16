"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INDEX = path.join(__dirname, "..", "public", "index.html");
const VERSION = require("../package.json").version;

// A content-derived identity for this install's behavior. The CLI compares a live
// server's reported `build` against its own; a mismatch means the server is running
// stale code (e.g. an old npx-cached copy squatting on the port) and should be
// replaced. Hashes the two behavior-defining files (state machine + served UI), so
// it changes whenever either does — even when the version string doesn't.
const BUILD = (() => {
  const h = crypto.createHash("sha1");
  for (const f of [__filename, INDEX]) {
    try { h.update(fs.readFileSync(f)); } catch {}
  }
  return h.digest("hex").slice(0, 12);
})();

// A browser counts as "watching" if it polled (with ?watch=1) within this window.
// Generous enough to survive background-tab timer throttling without a false miss.
const WATCH_TTL_MS = 60000;

function createServer({ initialAgent } = {}) {
  const state = {
    agent: initialAgent || "idle", // idle | working | waiting | done
    since: Date.now(),
    tools: 0,
    reason: "",
    seq: 0,
    lastSeen: 0, // last watcher poll; 0 = nobody watching
  };

  function set(agent, { reason, resetTools, bumpTool } = {}) {
    if (agent != null && agent !== state.agent) state.since = Date.now();
    if (agent != null) state.agent = agent;
    if (reason != null) state.reason = reason;
    if (resetTools) state.tools = 0;
    if (bumpTool) state.tools += 1;
    state.seq += 1;
  }

  function snapshot() {
    return {
      ...state,
      elapsed: +((Date.now() - state.since) / 1000).toFixed(1),
      watched: Date.now() - state.lastSeen < WATCH_TTL_MS,
      build: BUILD,
      version: VERSION,
    };
  }

  function extractMessage(raw) {
    if (!raw) return "";
    try {
      const p = JSON.parse(raw);
      for (const k of ["message", "notification", "text", "prompt"]) {
        if (typeof p[k] === "string" && p[k].trim()) return p[k].trim().slice(0, 200);
      }
    } catch {}
    return "";
  }

  function send(res, code, body, ctype = "application/json") {
    res.writeHead(code, { "Content-Type": ctype, "Cache-Control": "no-store" });
    res.end(body);
  }

  return http.createServer((req, res) => {
    const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (url === "/" || url.startsWith("/index"))) {
      return fs.readFile(INDEX, (err, buf) =>
        err
          ? send(res, 500, "index.html missing", "text/plain")
          : send(res, 200, buf, "text/html; charset=utf-8")
      );
    }
    if (req.method === "GET" && url === "/state") {
      // Only a real browser poll carries ?watch=1; the CLI's liveness ping doesn't,
      // so it never counts as "watching".
      if (req.url.includes("watch=1")) state.lastSeen = Date.now();
      return send(res, 200, JSON.stringify(snapshot()));
    }
    if (req.method === "POST" && url.startsWith("/event/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        switch (url) {
          case "/event/working":
            set("working", { reason: "", resetTools: true });
            break;
          case "/event/tool":
            set("working", { bumpTool: true });
            break;
          case "/event/waiting":
            set("waiting", { reason: extractMessage(raw) || "Agent needs your input" });
            break;
          case "/event/done":
            set("done", { reason: "" });
            break;
          case "/event/idle":
            set("idle", { reason: "", resetTools: true });
            break;
          case "/event/closed":
            // The watching tab is going away — mark unwatched immediately so the
            // next prompt reopens it instead of waiting out the TTL.
            state.lastSeen = 0;
            break;
          default:
            return send(res, 404, JSON.stringify({ error: "unknown event" }));
        }
        send(res, 200, JSON.stringify({ ok: true, state: snapshot() }));
      });
      return;
    }
    send(res, 404, JSON.stringify({ error: "not found" }));
  });
}

module.exports = { createServer, BUILD };

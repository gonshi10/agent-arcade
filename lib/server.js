"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INDEX = path.join(__dirname, "..", "public", "index.html");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const VERSION = require("../package.json").version;

// Allow-list of static asset extensions this project ever serves. Anything outside
// this set 404s rather than being served.
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// Manually walk public/ collecting every file whose extension is in CONTENT_TYPES.
// (Not using fs.readdirSync's `recursive` option — this project supports Node >=18,
// and that option needs Node 18.17+/20.1+.)
function walkPublicFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(walkPublicFiles(full));
    } else if (entry.isFile() && CONTENT_TYPES[path.extname(entry.name)]) {
      out.push(full);
    }
  }
  return out;
}

// A content-derived identity for this install's behavior. The CLI compares a live
// server's reported `build` against its own; a mismatch means the server is running
// stale code (e.g. an old npx-cached copy squatting on the port) and should be
// replaced. Hashes this file plus every served asset under public/ (walked
// recursively, sorted for determinism), so it changes whenever the state machine or
// any served UI file does — even when the version string doesn't.
const BUILD = (() => {
  const h = crypto.createHash("sha1");
  const files = [__filename, ...walkPublicFiles(PUBLIC_DIR).sort()];
  for (const f of files) {
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
    // Independent per-tab watcher timestamps, keyed by a client-chosen tab id
    // (falling back to a shared "default" key for callers that don't send
    // one, e.g. the CLI's liveness ping or a raw test request) — so closing
    // one open tab can't clobber another tab's watched status.
    watchers: new Map(),
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
    const { watchers, ...rest } = state;
    const now = Date.now();
    return {
      ...rest,
      elapsed: +((now - state.since) / 1000).toFixed(1),
      watched: [...watchers.values()].some((t) => now - t < WATCH_TTL_MS),
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

  // Identifies which browser tab a /state or /event/closed request came from,
  // so multiple open tabs each get their own watcher entry. Callers that don't
  // send one (CLI ping, raw test requests) all share one implicit key.
  function tabId(reqUrl) {
    return new URL(reqUrl, "http://localhost").searchParams.get("tab") || "default";
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
      if (req.url.includes("watch=1")) state.watchers.set(tabId(req.url), Date.now());
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
            // That tab is going away — drop just its own watcher entry immediately
            // (rather than waiting out the TTL), leaving any other open tab's
            // entry untouched.
            state.watchers.delete(tabId(req.url));
            break;
          default:
            return send(res, 404, JSON.stringify({ error: "unknown event" }));
        }
        send(res, 200, JSON.stringify({ ok: true, state: snapshot() }));
      });
      return;
    }
    if (req.method === "GET") {
      let decoded;
      try {
        decoded = decodeURIComponent(url);
      } catch {
        return send(res, 404, JSON.stringify({ error: "not found" }));
      }
      if (decoded.includes("\0")) {
        return send(res, 404, JSON.stringify({ error: "not found" }));
      }
      const resolved = path.normalize(path.join(PUBLIC_DIR, decoded));
      const withinPublic =
        resolved === PUBLIC_DIR || resolved.startsWith(PUBLIC_DIR + path.sep);
      const ctype = CONTENT_TYPES[path.extname(resolved)];
      if (!withinPublic || !ctype) {
        return send(res, 404, JSON.stringify({ error: "not found" }));
      }
      return fs.readFile(resolved, (err, buf) =>
        err
          ? send(res, 404, JSON.stringify({ error: "not found" }))
          : send(res, 200, buf, ctype)
      );
    }
    send(res, 404, JSON.stringify({ error: "not found" }));
  });
}

module.exports = { createServer, BUILD };

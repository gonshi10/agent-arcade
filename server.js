"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const INDEX = path.join(__dirname, "..", "public", "index.html");

function createServer() {
  const state = {
    agent: "idle", // idle | working | waiting | done
    since: Date.now(),
    tools: 0,
    reason: "",
    seq: 0,
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
    return { ...state, elapsed: +((Date.now() - state.since) / 1000).toFixed(1) };
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
    const url = req.url.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (url === "/" || url.startsWith("/index"))) {
      return fs.readFile(INDEX, (err, buf) =>
        err
          ? send(res, 500, "index.html missing", "text/plain")
          : send(res, 200, buf, "text/html; charset=utf-8")
      );
    }
    if (req.method === "GET" && url === "/state") {
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

module.exports = { createServer };

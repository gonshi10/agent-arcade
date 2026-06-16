"use strict";
const fs = require("fs");
const path = require("path");

const BLOCK_START = "# agent-arcade";
const BLOCK_END = "# /agent-arcade";

function findGitRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseIgnoreLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim());
}

function patternPresent(lines, pattern) {
  return lines.some((line) => line && !line.startsWith("#") && line === pattern);
}

function findBlockRange(lines) {
  const start = lines.findIndex((line) => line === BLOCK_START);
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line === BLOCK_END);
  if (end === -1) return null;
  return { start, end };
}

function buildBlockLines(patterns) {
  if (!patterns.length) return [];
  return [BLOCK_START, ...patterns, BLOCK_END];
}

function ensureGitignorePatterns(gitRoot, patterns) {
  const file = path.join(gitRoot, ".gitignore");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing.length ? parseIgnoreLines(existing) : [];

  const missing = patterns.filter((p) => !patternPresent(lines, p));
  const range = findBlockRange(lines);

  if (!missing.length) {
    return { file, added: [], skipped: true };
  }

  const blockLines = buildBlockLines(missing);
  let next;

  if (range) {
    const before = lines.slice(0, range.start);
    const after = lines.slice(range.end + 1);
    const inner = lines.slice(range.start + 1, range.end);
    const innerPatterns = inner.filter((line) => line && !line.startsWith("#"));
    const merged = [...new Set([...innerPatterns, ...missing])];
    const newBlock = buildBlockLines(merged);
    next = [...before, ...newBlock, ...after];
  } else {
    const trimmed = lines.filter((line, i) => line.length > 0 || i < lines.length - 1);
    next = trimmed.length ? [...trimmed, "", ...blockLines] : blockLines;
  }

  const text = next.join("\n") + "\n";
  fs.writeFileSync(file, text);
  return { file, added: missing, skipped: false };
}

module.exports = {
  BLOCK_START,
  BLOCK_END,
  findGitRoot,
  ensureGitignorePatterns,
  patternPresent,
};

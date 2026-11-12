// Small helpers shared by every section: running commands, sizes, paths.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

export const HOME = os.homedir();
export const UID = process.getuid();
export const DAY = 24 * 60 * 60 * 1000;

/** Run a program without a shell. Resolves { ok, stdout, stderr, code }. */
export function run(file, args = [], { timeout = 60_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: stdout || "",
        stderr: (stderr || (err && !stdout ? String(err.message) : "")).trim(),
      });
    });
  });
}

/** Quote one argument so a shown command can be pasted into Terminal. */
export function shq(arg) {
  const s = String(arg);
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
export const cmdline = (file, args) => [file, ...args].map(shq).join(" ");

/** Replace the home folder with ~ for display. */
export const tilde = (p) => (p && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

/** Size of a folder or file in bytes, via du (counts real blocks, follows nothing). */
export async function duBytes(p, timeout = 300_000) {
  const r = await run("/usr/bin/du", ["-sk", p], { timeout });
  const kb = parseInt(r.stdout.split("\t")[0], 10);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

export async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(p) {
  try {
    return await fs.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function mtime(p) {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** Read any plist (binary or XML) as JSON. Falls back to XML text parsing for dates. */
export async function readPlist(p) {
  const r = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", p], { timeout: 10_000 });
  if (r.ok) {
    try {
      return JSON.parse(r.stdout);
    } catch {
      /* fall through */
    }
  }
  // JSON conversion fails when the plist holds dates. Pull simple keys from plutil -p instead.
  const t = await run("/usr/bin/plutil", ["-p", p], { timeout: 10_000 });
  if (!t.ok) return null;
  const out = {};
  for (const line of t.stdout.split("\n")) {
    const m = line.match(/^ {2}"([^"]+)" => (.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    else if (v === "true" || v === "false") v = v === "true";
    else if (/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}$/.test(v)) v = new Date(v.replace(" ", "T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2")).toISOString();
    out[m[1]] = v;
  }
  return out;
}

/** Run async work over items with a fixed number running at once. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Parse ps "etime" ([[dd-]hh:]mm:ss) into seconds. */
export function etimeToSeconds(s) {
  if (!s) return 0;
  let days = 0;
  let rest = s.trim();
  if (rest.includes("-")) {
    const [d, r] = rest.split("-");
    days = parseInt(d, 10);
    rest = r;
  }
  const parts = rest.split(":").map((x) => parseInt(x, 10));
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function newId(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

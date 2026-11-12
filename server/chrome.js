// Google Chrome tabs: count them, close all but the one in front, and reopen closed ones.
// Uses Apple Events (JXA). macOS asks once to allow controlling Chrome.
import fs from "node:fs";
import path from "node:path";
import { run } from "./util.js";
import { STATE_DIR } from "./config.js";

const CLOSED_DIR = path.join(STATE_DIR, "closed-tabs");

function jxa(script, timeout = 60_000) {
  return run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout });
}

const blocked = (stderr) => /-1743|not allowed|Not authorized/i.test(stderr);
export const BLOCKED_MESSAGE = "macOS blocked controlling Chrome. Allow it in System Settings → Privacy & Security → Automation (Google Chrome under your terminal or Claude), then try again.";

export async function chromeRunning() {
  const r = await run("/usr/bin/pgrep", ["-x", "Google Chrome"]);
  return r.ok;
}

/** { running, windows, tabs, keep: { title, url } } or { running, error } */
export async function chromeTabs() {
  if (!(await chromeRunning())) return { running: false };
  const r = await jxa(`
    const c = Application("Google Chrome");
    const wins = c.windows();
    let tabs = 0;
    for (const w of wins) tabs += w.tabs.length;
    const front = wins.length ? wins[0].activeTab : null;
    JSON.stringify({ windows: wins.length, tabs, keep: front ? { title: front.title(), url: front.url() } : null });
  `);
  if (!r.ok) return { running: true, error: blocked(r.stderr) ? BLOCKED_MESSAGE : r.stderr };
  return { running: true, ...JSON.parse(r.stdout) };
}

/** Close every tab except the active tab of the front window. Saves what it closed. */
export async function closeOtherTabs() {
  const r = await jxa(
    `
    const c = Application("Google Chrome");
    const wins = c.windows();
    const keepId = wins.length ? wins[0].activeTab.id() : null;
    const closed = [];
    for (const w of wins) {
      const tabs = w.tabs();
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.id() === keepId) continue;
        closed.push({ title: t.title(), url: t.url() });
        t.close();
      }
    }
    JSON.stringify(closed.reverse());
  `,
    300_000
  );
  if (!r.ok) return { ok: false, message: blocked(r.stderr) ? BLOCKED_MESSAGE : r.stderr };
  const closed = JSON.parse(r.stdout || "[]");
  const saved = saveClosed(closed);
  return { ok: true, message: `Closed ${closed.length} tab${closed.length === 1 ? "" : "s"}. The list is saved, so you can reopen them from the Memory page.`, saved };
}

function saveClosed(tabs) {
  if (!tabs.length) return null;
  fs.mkdirSync(CLOSED_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(CLOSED_DIR, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: Date.now(), tabs }, null, 2));
  // A plain HTML page of links too, so the tabs can be found even without this app.
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  fs.writeFileSync(file.replace(/\.json$/, ".html"), `<!doctype html><meta charset="utf-8"><title>Closed tabs ${stamp}</title><ol>${tabs.map((t) => `<li><a href="${esc(t.url)}">${esc(t.title || t.url)}</a></li>`).join("")}</ol>`);
  return file;
}

/** Saved batches of closed tabs, newest first. */
export function closedTabBatches() {
  let files = [];
  try {
    files = fs.readdirSync(CLOSED_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(CLOSED_DIR, f), "utf8"));
        return { id: f.replace(/\.json$/, ""), at: d.at, count: d.tabs.length, reopened: !!d.reopened };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
    .slice(0, 10);
}

export function readBatch(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(CLOSED_DIR, `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export async function reopenBatch(id) {
  const batch = readBatch(id);
  if (!batch) return { ok: false, message: "That list of tabs is gone." };
  const urls = batch.tabs.map((t) => t.url).filter((u) => /^(https?|file|chrome):/i.test(u));
  // `open` needs no Automation permission. Chrome opens each URL as a new tab.
  for (let i = 0; i < urls.length; i += 20) {
    const r = await run("/usr/bin/open", ["-a", "Google Chrome", ...urls.slice(i, i + 20)], { timeout: 60_000 });
    if (!r.ok) return { ok: false, message: r.stderr };
  }
  batch.reopened = true;
  fs.writeFileSync(path.join(CLOSED_DIR, `${id}.json`), JSON.stringify(batch, null, 2));
  return { ok: true, message: `Reopened ${urls.length} tab${urls.length === 1 ? "" : "s"}.` };
}

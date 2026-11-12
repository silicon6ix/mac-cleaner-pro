// Optimize disk: find reclaimable space, measure it, and remove only what the person ticks.
// Folders and files go to the Trash. Simulators and runtimes are removed with simctl.
import path from "node:path";
import fs from "node:fs/promises";
import { run, cmdline, tilde, HOME, DAY, duBytes, exists, listDir, mtime, readPlist, pool, newId } from "./util.js";
import { makePlan } from "./plans.js";
import { loadConfig } from "./config.js";

const XCODE = `${HOME}/Library/Developer/Xcode`;
const DD = `${XCODE}/DerivedData`;
const CORESIM = `${HOME}/Library/Developer/CoreSimulator`;
const CACHES = `${HOME}/Library/Caches`;
const LOGS = `${HOME}/Library/Logs`;
const DOWNLOADS = `${HOME}/Downloads`;
const TRASH = `${HOME}/.Trash`;

/** Only paths strictly inside these folders can ever be moved to the Trash. */
const TRASHABLE_ROOTS = [XCODE, `${CORESIM}/Caches`, CACHES, LOGS, DOWNLOADS, `${HOME}/.npm`, `${HOME}/Library/pnpm`, `${HOME}/.gradle/caches`];
// Inside ~/Library/Developer/Xcode only these names are fair game.
const XCODE_TOP_ALLOWED = new Set(["DerivedData", "Archives", "iOS DeviceSupport", "watchOS DeviceSupport", "tvOS DeviceSupport", "macOS DeviceSupport", "visionOS DeviceSupport", "DocumentationCache", "iOS Device Logs", "DeviceLogs", "UserData"]);

export const CATEGORIES = [
  { id: "xcode", title: "Xcode junk", icon: "hammer", blurb: "Build folders, old device files and caches Xcode makes as you work. Xcode makes them again when it needs them, but the next build of that project takes longer." },
  { id: "simulators", title: "Simulators", icon: "phone", blurb: "Broken or long-unused iPhone simulators, and simulator system versions (runtimes) you haven't used in a while. Each runtime is about 7–9 GB." },
  { id: "devcaches", title: "Developer caches", icon: "box", blurb: "Download caches for npm, Yarn, pnpm, Homebrew, pip, CocoaPods and Swift packages. They fill again the next time you install something." },
  { id: "appcaches", title: "App caches", icon: "grid", blurb: "Caches other apps keep in your Library. Apps rebuild them, so they may feel slower the first time. Quit an app before clearing its cache." },
  { id: "logs", title: "App logs", icon: "doc", blurb: "Old log files apps write for troubleshooting." },
  { id: "downloads", title: "Big old downloads", icon: "download", blurb: "Installers and large files in Downloads that you haven't touched in a while. Look at each one before ticking it." },
  { id: "trash", title: "Trash", icon: "trash", blurb: "Things you already moved to the Trash. Emptying it is the step that actually frees the space, and it can't be undone." },
];

let current = null; // latest scan job

function itemBase(category, fields) {
  return { id: newId("i_"), category, size: null, lastUsed: null, tags: [], checked: false, protected: false, warn: null, action: "trash", ...fields };
}

const humanAge = (ms) => {
  if (!ms) return "never";
  const d = Math.floor((Date.now() - ms) / DAY);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

// ---------- finders (fast: names and dates only; sizes are measured afterwards) ----------

async function findXcode(cfg) {
  const items = [];
  const inUseMs = cfg.inUseDays * DAY;
  // DerivedData, one item per project build folder
  const dd = await listDir(DD);
  const folders = [];
  for (const e of dd) {
    if (!e.isDirectory()) continue;
    const full = path.join(DD, e.name);
    if (/^(ModuleCache|SymbolCache|SDKStatCaches|CompilationCache)\.noindex$/.test(e.name)) {
      items.push(itemBase("xcode", { name: `Shared ${e.name.replace(".noindex", "")} cache`, detail: "Shared by every project. Every project rebuilds a little slower once.", path: full, lastUsed: await mtime(full) }));
      continue;
    }
    if (/^Unsaved_Xcode_Document/.test(e.name)) {
      items.push(itemBase("xcode", { name: e.name.replace(/-[a-z]{28}$/, ""), detail: "Leftover from an Xcode window that was never saved.", path: full, lastUsed: await mtime(full), checked: true, group: "Leftovers" }));
      continue;
    }
    const info = (await readPlist(path.join(full, "info.plist"))) || {};
    const last = info.LastAccessedDate ? Date.parse(info.LastAccessedDate) : await mtime(full);
    const project = e.name.replace(/-[a-z]{28}$/, "");
    const agent = /-agent-/.test(e.name);
    folders.push({ name: e.name, full, last, project, agent, workspace: info.WorkspacePath || null });
  }
  // The newest non-agent build folder of each project used in the last month is the "main" one.
  // Keyed by workspace when Xcode recorded it, else by project name (info.plist can be missing).
  const mainByWorkspace = new Map();
  for (const f of folders) {
    if (f.agent || Date.now() - f.last > 30 * DAY) continue;
    const key = f.workspace || f.project;
    const prev = mainByWorkspace.get(key);
    if (!prev || prev.last < f.last) mainByWorkspace.set(key, f);
  }
  const mains = new Set([...mainByWorkspace.values()].map((f) => f.name));
  for (const f of folders) {
    const isProtected = mains.has(f.name) || cfg.protectDerivedData.includes(f.name);
    const inUse = Date.now() - f.last < inUseMs;
    const tags = [];
    if (isProtected) tags.push("Main project");
    if (f.agent) tags.push("Agent copy");
    if (inUse) tags.push("In use");
    else if (Date.now() - f.last > 14 * DAY) tags.push("Stale");
    items.push(
      itemBase("xcode", {
        name: f.agent ? `${f.project.replace(/-agent-.*/, "")} (agent ${f.project.replace(/^.*-agent-/, "")})` : f.project,
        detail: `Build folder${f.workspace ? ` for ${tilde(f.workspace)}` : ""}. Last used ${humanAge(f.last)}.`,
        path: f.full,
        lastUsed: f.last,
        tags,
        protected: isProtected,
        checked: !isProtected && !inUse,
        warn: isProtected ? "This is the build folder for your main project. Removing it means a full rebuild (6–12 minutes)." : inUse ? `Used in the last ${cfg.inUseDays} days. Removing it slows that project's next build.` : null,
        group: "Build folders (DerivedData)",
        tech: `${tilde(f.full)}${f.workspace ? `\nworkspace: ${f.workspace}` : ""}`,
      })
    );
  }
  // Device support files (one per iOS version that was connected)
  // Folder names look like "iPhone15,3 18.6 (22G86)". The newest version per device model is
  // probably the one on that device today, so it stays unticked.
  for (const kind of ["iOS", "watchOS", "tvOS", "macOS", "visionOS"]) {
    const root = `${XCODE}/${kind} DeviceSupport`;
    const entries = [];
    for (const e of await listDir(root)) {
      if (!e.isDirectory()) continue;
      const m = e.name.match(/^(?:(\S+,\S+) )?(\d+(?:\.\d+)*)/);
      entries.push({ name: e.name, full: path.join(root, e.name), model: m?.[1] || "any", version: m?.[2] || "0", last: await mtime(path.join(root, e.name)) });
    }
    const newest = new Map();
    for (const x of entries) if (!newest.has(x.model) || compareVersions(x.version, newest.get(x.model).version) > 0) newest.set(x.model, x);
    for (const x of entries) {
      const keep = newest.get(x.model) === x;
      items.push(itemBase("xcode", { name: `${kind} ${x.name}`, detail: `Debug files Xcode copied from a connected ${x.model === "any" ? "device" : x.model}. ${keep ? "The newest version for this device, so it's probably still needed." : "A newer version for the same device exists."} Xcode copies them again (a few minutes) if you plug in a device with this version.`, path: x.full, lastUsed: x.last, checked: !keep, tags: keep ? ["Newest"] : ["Older version"], group: "Device support files" }));
    }
  }
  // Archives
  const arch = `${XCODE}/Archives`;
  for (const day of await listDir(arch)) {
    if (!day.isDirectory()) continue;
    for (const a of await listDir(path.join(arch, day.name))) {
      if (!a.name.endsWith(".xcarchive")) continue;
      const full = path.join(arch, day.name, a.name);
      const info = (await readPlist(path.join(full, "Info.plist"))) || {};
      const last = info.CreationDate ? Date.parse(info.CreationDate) : await mtime(full);
      items.push(itemBase("xcode", { name: a.name.replace(/\.xcarchive$/, ""), detail: `App build archived ${humanAge(last)}. It holds the crash symbols (dSYM) for that build. Keep it if crash reports from that version still need symbols.`, path: full, lastUsed: last, group: "Archives", warn: "Keeps the crash symbols for a shipped build." }));
    }
  }
  for (const [rel, name, detail, checked] of [
    ["DocumentationCache", "Documentation cache", "Downloaded developer documentation. Xcode downloads it again when you open the docs.", true],
    ["UserData/Previews", "SwiftUI preview data", "Simulators and builds made for SwiftUI previews.", true],
    ["iOS Device Logs", "Device logs", "Logs copied from connected devices.", true],
    ["DeviceLogs", "Device logs (older)", "Logs copied from connected devices.", true],
  ]) {
    const full = `${XCODE}/${rel}`;
    if (await exists(full)) items.push(itemBase("xcode", { name, detail, path: full, lastUsed: await mtime(full), checked, group: "Other Xcode data" }));
  }
  return items;
}

async function findSimulators() {
  const items = [];
  const [devs, rts] = await Promise.all([
    run("/usr/bin/xcrun", ["simctl", "list", "devices", "-j"], { timeout: 60_000 }),
    run("/usr/bin/xcrun", ["simctl", "runtime", "list", "-j"], { timeout: 60_000 }),
  ]);
  if (devs.ok) {
    const data = JSON.parse(devs.stdout).devices || {};
    const unavailable = [];
    for (const [runtime, list] of Object.entries(data)) {
      for (const d of list) {
        const rt = runtime.replace(/^.*SimRuntime\./, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1");
        if (d.isAvailable === false) {
          unavailable.push({ ...d, rt });
          continue;
        }
        const last = d.lastBootedAt ? Date.parse(d.lastBootedAt) : null;
        if (d.state !== "Shutdown") continue;
        const age = last ? Date.now() - last : Infinity;
        if (age < 60 * DAY) continue;
        items.push(itemBase("simulators", { name: `${d.name} (${rt})`, detail: `Simulator last started ${humanAge(last)}. Deleting it removes its installed apps and data.`, size: (d.dataPathSize || 0) + (d.logPathSize || 0), lastUsed: last, checked: age > 180 * DAY, tags: ["Stale"], action: "sim-delete", udid: d.udid, group: "Unused simulators", tech: `udid ${d.udid}\n${tilde(d.dataPath)}` }));
      }
    }
    if (unavailable.length) {
      items.push(itemBase("simulators", { name: `${unavailable.length} broken simulator${unavailable.length > 1 ? "s" : ""}`, detail: "Simulators whose system version is no longer installed. They can't start anymore.", size: unavailable.reduce((s, d) => s + (d.dataPathSize || 0) + (d.logPathSize || 0), 0), checked: true, action: "sim-delete-unavailable", group: "Broken simulators", tech: unavailable.map((d) => `${d.name} (${d.rt}) ${d.udid}`).join("\n") }));
    }
  }
  if (rts.ok) {
    const data = JSON.parse(rts.stdout);
    const list = Object.entries(data).map(([id, r]) => ({ id, ...r }));
    // Keep the newest runtime of each platform no matter what.
    const newest = new Map();
    for (const r of list) {
      const key = r.platformIdentifier || "";
      const cur = newest.get(key);
      if (!cur || compareVersions(r.version, cur.version) > 0) newest.set(key, r);
    }
    for (const r of list) {
      const last = r.lastUsedAt ? Date.parse(r.lastUsedAt) : null;
      const age = last ? Date.now() - last : Infinity;
      const isNewest = newest.get(r.platformIdentifier || "") === r;
      const platform = /iphone/i.test(r.platformIdentifier || "") ? "iOS" : /watch/i.test(r.platformIdentifier || "") ? "watchOS" : /appletv/i.test(r.platformIdentifier || "") ? "tvOS" : /xr/i.test(r.platformIdentifier || "") ? "visionOS" : "";
      const tags = isNewest ? ["Newest"] : age < 14 * DAY ? ["In use"] : age > 90 * DAY ? ["Stale"] : [];
      items.push(itemBase("simulators", { name: `${platform} ${r.version} simulator runtime`.trim(), detail: `Used ${humanAge(last)}. Removing it also makes its simulators unusable. Xcode can download it again (Settings → Components).`, size: r.sizeBytes || null, lastUsed: last, checked: !isNewest && age > 180 * DAY && r.deletable !== false, tags, protected: isNewest, warn: isNewest ? "The newest runtime for this platform. Kept unless you unlock it." : null, action: "runtime-delete", runtimeId: r.identifier || r.id, group: "Simulator runtimes", tech: `${r.identifier || r.id} · ${r.build || ""} · ${r.kind || ""}` }));
    }
  }
  if (await exists(`${CORESIM}/Caches`)) items.push(itemBase("simulators", { name: "Simulator caches", detail: "Shared caches the simulators rebuild when they start.", path: `${CORESIM}/Caches`, checked: true, group: "Caches" }));
  return items;
}

function compareVersions(a = "", b = "") {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

const DEV_CACHE_NAMES = new Set(["Homebrew", "pip", "Yarn", "CocoaPods", "org.swift.swiftpm", "pnpm", "node-gyp", "ms-playwright", "typescript", "deno", "bun"]);

async function findDevCaches() {
  const items = [];
  const add = async (name, p, detail, extra = {}) => {
    if (p && (await exists(p))) items.push(itemBase("devcaches", { name, detail, path: p, lastUsed: await mtime(p), checked: true, ...extra }));
  };
  await add("npm download cache", `${HOME}/.npm/_cacache`, "Packages npm downloaded before. npm downloads them again when needed.");
  const yarn = await run("/opt/homebrew/bin/yarn", ["cache", "dir"], { timeout: 15_000 });
  const yarnDir = yarn.ok ? yarn.stdout.trim() : `${CACHES}/Yarn`;
  await add("Yarn download cache", yarnDir.startsWith(CACHES + "/Yarn") ? `${CACHES}/Yarn` : yarnDir, "Packages Yarn downloaded before.");
  const pnpmStore = `${HOME}/Library/pnpm/store`;
  if (await exists(pnpmStore)) {
    items.push(itemBase("devcaches", { name: "pnpm store (unused packages only)", detail: "pnpm keeps one copy of every package. This removes only packages no project uses anymore, so your projects keep working.", path: pnpmStore, lastUsed: await mtime(pnpmStore), checked: true, action: "pnpm-prune", sizeNote: "Size shown is the whole store; only the unused part is removed." }));
  }
  await add("Homebrew download cache", `${CACHES}/Homebrew`, "Installers Homebrew downloaded. Installed tools keep working.");
  await add("pip download cache", `${CACHES}/pip`, "Python packages pip downloaded before.");
  await add("CocoaPods cache", `${CACHES}/CocoaPods`, "Pods downloaded before. `pod install` fetches them again.");
  await add("Swift package cache", `${CACHES}/org.swift.swiftpm`, "Swift packages downloaded before. Xcode fetches them again on the next package resolve.");
  await add("Playwright browsers", `${CACHES}/ms-playwright`, "Test browsers Playwright downloaded. Reinstall with `npx playwright install`.", { checked: false });
  await add("Gradle caches", `${HOME}/.gradle/caches`, "Android/Java build downloads.", { checked: false });
  return items;
}

async function findAppCaches() {
  const items = [];
  for (const e of await listDir(CACHES)) {
    if (DEV_CACHE_NAMES.has(e.name) || e.name.startsWith("com.apple.") || e.name.startsWith(".")) continue;
    const full = path.join(CACHES, e.name);
    items.push(itemBase("appcaches", { name: e.name, detail: "App cache.", path: full, lastUsed: await mtime(full), minSize: 20 * 1024 * 1024 }));
  }
  return items;
}

async function findLogs() {
  const items = [];
  for (const e of await listDir(LOGS)) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(LOGS, e.name);
    const last = await mtime(full);
    items.push(itemBase("logs", { name: e.name, detail: `Logs, last written ${humanAge(last)}.`, path: full, lastUsed: last, checked: Date.now() - last > 7 * DAY, minSize: 5 * 1024 * 1024 }));
  }
  return items;
}

async function findDownloads() {
  const items = [];
  const seen = new Set();
  const big = await run("/usr/bin/find", [DOWNLOADS, "-maxdepth", "3", "-type", "f", "-size", "+100M", "-mtime", "+30"], { timeout: 60_000 });
  const inst = await run("/usr/bin/find", [DOWNLOADS, "-maxdepth", "3", "-type", "f", "(", "-iname", "*.dmg", "-o", "-iname", "*.pkg", "-o", "-iname", "*.xip", "-o", "-iname", "*.iso", ")", "-size", "+10M", "-mtime", "+7"], { timeout: 60_000 });
  if (!big.ok && !inst.ok && /not permitted/i.test(big.stderr)) return { items, note: "macOS didn't let this app look in Downloads. Give your terminal app access in System Settings → Privacy & Security → Files and Folders." };
  for (const p of [...inst.stdout.split("\n"), ...big.stdout.split("\n")]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    const st = await fs.stat(p).catch(() => null);
    if (!st) continue;
    const isInstaller = /\.(dmg|pkg|xip|iso)$/i.test(p);
    items.push(itemBase("downloads", { name: path.basename(p), detail: `${isInstaller ? "Installer" : "Large file"} in ${tilde(path.dirname(p))}, last changed ${humanAge(st.mtimeMs)}.`, path: p, size: st.blocks ? st.blocks * 512 : st.size, lastUsed: st.mtimeMs, group: isInstaller ? "Installers" : "Large files" }));
  }
  return { items };
}

async function findTrash() {
  const r = await run("/usr/bin/du", ["-sk", TRASH], { timeout: 120_000 });
  const kb = parseInt(r.stdout, 10);
  const blocked = !r.ok && /not permitted/i.test(r.stderr);
  return [itemBase("trash", { name: "Empty the Trash", detail: blocked ? "macOS doesn't let this app look inside the Trash, so the size is unknown. Emptying still works: Finder does it for you." : "Permanently deletes everything in the Trash.", size: Number.isFinite(kb) ? kb * 1024 : null, sizeKnown: Number.isFinite(kb), action: "empty-trash", warn: "Can't be undone.", tech: "Asks Finder to empty the Trash (osascript). The first time, macOS may ask you to allow controlling Finder." })];
}

// ---------- scan job ----------

export function startScan() {
  const cfg = loadConfig();
  const job = { id: newId("s_"), startedAt: Date.now(), done: false, categories: CATEGORIES.map((c) => ({ ...c, status: "finding", note: null, items: [] })) };
  current = job;
  const cat = (id) => job.categories.find((c) => c.id === id);
  const finders = {
    xcode: () => findXcode(cfg),
    simulators: findSimulators,
    devcaches: findDevCaches,
    appcaches: findAppCaches,
    logs: findLogs,
    downloads: findDownloads,
    trash: findTrash,
  };
  (async () => {
    await Promise.all(
      Object.entries(finders).map(async ([id, fn]) => {
        try {
          const res = await fn();
          const items = Array.isArray(res) ? res : res.items;
          if (!Array.isArray(res) && res.note) cat(id).note = res.note;
          cat(id).items = items;
          cat(id).status = "measuring";
        } catch (e) {
          cat(id).status = "error";
          cat(id).note = String(e.message || e);
        }
      })
    );
    // Measure sizes, biggest folders last so small categories finish first.
    const toMeasure = job.categories.flatMap((c) => c.items.filter((i) => i.size == null && i.path && i.action !== "empty-trash"));
    await pool(toMeasure, 6, async (item) => {
      item.size = (await duBytes(item.path)) ?? 0;
    });
    for (const c of job.categories) {
      c.items = c.items.filter((i) => !(i.minSize && (i.size || 0) < i.minSize));
      if (c.id === "devcaches" || c.id === "xcode") c.items = c.items.filter((i) => i.action !== "trash" || (i.size || 0) > 0 || /Unsaved/.test(i.name));
      c.items.sort((a, b) => (b.size || 0) - (a.size || 0));
      if (c.status !== "error") c.status = "done";
    }
    job.done = true;
    job.finishedAt = Date.now();
  })();
  return publicScan(job);
}

export function publicScan(job = current) {
  if (!job) return null;
  return {
    id: job.id,
    done: job.done,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    categories: job.categories.map((c) => ({
      id: c.id,
      title: c.title,
      icon: c.icon,
      blurb: c.blurb,
      status: c.status,
      note: c.note,
      items: c.items.map(({ path: p, udid, runtimeId, minSize, ...rest }) => ({ ...rest, where: p ? tilde(p) : null })),
    })),
  };
}

// ---------- plan ----------

// Folders that may be removed as a whole (the scan offers them as one item).
const WHOLE_FOLDERS = new Set([`${CORESIM}/Caches`, `${XCODE}/DocumentationCache`, `${XCODE}/UserData/Previews`, `${XCODE}/iOS Device Logs`, `${XCODE}/DeviceLogs`, `${HOME}/.gradle/caches`]);

export function insideAllowedRoot(real) {
  if (WHOLE_FOLDERS.has(real)) return true;
  if (real.startsWith(XCODE + "/")) {
    const rel = real.slice(XCODE.length + 1);
    const top = rel.split("/")[0];
    // Never a whole top-level Xcode folder (DerivedData, Archives, ...) unless listed above.
    if (!rel.includes("/") || !XCODE_TOP_ALLOWED.has(top)) return false;
    if (top === "UserData" && !rel.startsWith("UserData/Previews/")) return false;
  }
  return TRASHABLE_ROOTS.some((root) => real.startsWith(root + "/") && real.length > root.length + 1);
}

export async function planDisk(itemIds, { unlock = [], deleteNow = false } = {}) {
  if (!current || !current.done) throw new Error("Wait for the scan to finish, then try again.");
  const all = new Map(current.categories.flatMap((c) => c.items).map((i) => [i.id, i]));
  const chosen = itemIds.map((id) => all.get(id)).filter(Boolean);
  if (!chosen.length) throw new Error("Nothing is selected.");
  const locked = chosen.filter((i) => i.protected && !unlock.includes(i.id));
  if (locked.length) throw new Error(`"${locked[0].name}" is protected. Unlock it first if you really want to remove it.`);

  const steps = [];
  const warnings = [];
  const trashItems = chosen.filter((i) => i.action === "trash");
  let total = 0;
  for (const i of chosen) if (i.action !== "pnpm-prune" && i.action !== "empty-trash") total += i.size || 0;

  if (trashItems.length) {
    const checked = [];
    for (const i of trashItems) {
      const real = await fs.realpath(i.path).catch(() => null);
      if (!real || !insideAllowedRoot(real)) throw new Error(`Refusing to touch ${tilde(i.path)}: it's outside the folders this app cleans.`);
      checked.push({ ...i, real });
    }
    const label = deleteNow ? "Delete right away (skips the Trash)" : "Move to the Trash";
    for (const i of checked) {
      steps.push({
        label: `${label}: ${i.name}`,
        command: deleteNow ? cmdline("rm", ["-rf", i.real]) : cmdline("trash", [i.real]),
        run: async () => {
          const real = await fs.realpath(i.path).catch(() => null);
          if (!real) return { ok: true, message: "Already gone." };
          if (real !== i.real || !insideAllowedRoot(real)) return { ok: false, message: "The path changed since the preview; skipped." };
          if (deleteNow) {
            await fs.rm(real, { recursive: true, force: true });
            return { ok: true, message: "Deleted." };
          }
          const r = await run("/usr/bin/trash", [real], { timeout: 600_000 });
          return r.ok ? { ok: true, message: "Moved to the Trash." } : { ok: false, message: r.stderr || "Couldn't move it to the Trash." };
        },
      });
    }
    if (deleteNow) warnings.push("These folders are deleted right away and can't be put back.");
    else warnings.push("Items go to the Trash, so you can put them back. The space comes back after you empty the Trash.");
  }
  for (const i of chosen.filter((x) => x.action === "sim-delete")) {
    steps.push({ label: `Delete simulator ${i.name}`, command: cmdline("xcrun", ["simctl", "delete", i.udid]), run: () => simctl(["delete", i.udid]) });
  }
  if (chosen.some((i) => i.action === "sim-delete-unavailable")) {
    steps.push({ label: "Delete broken simulators", command: cmdline("xcrun", ["simctl", "delete", "unavailable"]), run: () => simctl(["delete", "unavailable"]) });
  }
  for (const i of chosen.filter((x) => x.action === "runtime-delete")) {
    steps.push({ label: `Remove ${i.name}`, command: cmdline("xcrun", ["simctl", "runtime", "delete", i.runtimeId]), run: () => simctl(["runtime", "delete", i.runtimeId], 600_000) });
  }
  if (chosen.some((x) => x.action.startsWith("sim") || x.action === "runtime-delete")) warnings.push("Simulators and runtimes are removed for good, not moved to the Trash. Xcode can download runtimes again.");
  if (chosen.some((i) => i.action === "pnpm-prune")) {
    steps.push({
      label: "Remove unused packages from the pnpm store",
      command: "pnpm store prune",
      run: async () => {
        const r = await run("/opt/homebrew/bin/pnpm", ["store", "prune"], { timeout: 600_000 });
        return { ok: r.ok, message: r.ok ? r.stdout.trim().split("\n").pop() || "Done." : r.stderr };
      },
    });
  }
  if (chosen.some((i) => i.action === "empty-trash")) {
    warnings.push("Emptying the Trash permanently deletes everything in it, including things you put there yourself.");
    steps.push({
      label: "Empty the Trash",
      command: cmdline("osascript", ["-e", 'tell application "Finder" to empty trash']),
      run: async () => {
        const r = await run("/usr/bin/osascript", ["-e", 'tell application "Finder" to empty trash'], { timeout: 900_000 });
        return r.ok ? { ok: true, message: "Trash emptied." } : { ok: false, message: /-1743|not allowed/i.test(r.stderr) ? "macOS blocked this. Allow controlling Finder in System Settings → Privacy & Security → Automation." : r.stderr };
      },
    });
  }
  if (chosen.some((i) => i.protected)) warnings.unshift("You unlocked a protected item. Removing it means a long rebuild or download.");
  const removedIds = new Set(chosen.map((i) => i.id));
  return makePlan({
    title: `Clean ${chosen.length} item${chosen.length > 1 ? "s" : ""}`,
    summary: `Frees about ${fmt(total)}${trashItems.length && !deleteNow ? " once the Trash is emptied" : ""}.`,
    reclaimBytes: total,
    warnings,
    steps,
    afterRun: (results) => {
      // Drop finished items from the scan so the list matches the disk.
      if (!current) return;
      const failedLabels = new Set(results.filter((r) => !r.ok).map((r) => r.label));
      for (const c of current.categories) c.items = c.items.filter((i) => !removedIds.has(i.id) || [...failedLabels].some((l) => l.endsWith(i.name)));
    },
  });
}

async function simctl(args, timeout = 300_000) {
  const r = await run("/usr/bin/xcrun", ["simctl", ...args], { timeout });
  return { ok: r.ok, message: r.ok ? "Done." : r.stderr };
}

function fmt(b) {
  if (!b) return "0 bytes";
  const u = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) {
    b /= 1000;
    i++;
  }
  return `${b.toFixed(b >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export async function diskFree() {
  const r = await run("/bin/df", ["-k", "/System/Volumes/Data"]);
  const line = r.stdout.trim().split("\n")[1] || "";
  const parts = line.split(/\s+/);
  return { total: +parts[1] * 1024, used: +parts[2] * 1024, free: +parts[3] * 1024 };
}

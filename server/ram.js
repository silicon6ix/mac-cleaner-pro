// Optimize RAM: memory pressure, swap, top apps, and the things that usually eat memory
// on a development Mac (simulators, idle debugger helpers, forgotten dev servers, apps).
import path from "node:path";
import { run, cmdline, tilde, HOME } from "./util.js";
import { makePlan } from "./plans.js";
import { readState, writeState } from "./config.js";
import { chromeTabs, closeOtherTabs } from "./chrome.js";

const APP_DIRS = ["/Applications/", `${HOME}/Applications/`, "/System/Applications/"];
const DEV_RUNTIMES = new Set(["node", "bun", "deno"]);

function parseVmStat(text) {
  const pageSize = parseInt((text.match(/page size of (\d+)/) || [])[1] || "16384", 10);
  const v = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^"?([^":]+)"?:\s+(\d+)\.?$/);
    if (m) v[m[1].trim()] = parseInt(m[2], 10) * pageSize;
  }
  return v;
}

function parseSize(s) {
  const m = String(s || "").match(/^(\d+(?:\.\d+)?)([BKMGT])?/);
  if (!m) return 0;
  const mult = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[m[2] || "B"];
  return Math.round(parseFloat(m[1]) * mult);
}

export async function memoryOverview() {
  const [mem, vm, swap, level, mp] = await Promise.all([
    run("/usr/sbin/sysctl", ["-n", "hw.memsize"]),
    run("/usr/bin/vm_stat"),
    run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]),
    run("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    run("/usr/bin/memory_pressure", ["-Q"], { timeout: 10_000 }),
  ]);
  const total = parseInt(mem.stdout, 10);
  const v = parseVmStat(vm.stdout);
  const app = Math.max(0, (v["Anonymous pages"] || 0) - (v["Pages purgeable"] || 0));
  const wired = v["Pages wired down"] || 0;
  const compressed = v["Pages occupied by compressor"] || 0;
  const cached = (v["File-backed pages"] || 0) + (v["Pages purgeable"] || 0);
  const sw = swap.stdout.match(/total = ([\d.]+)M\s+used = ([\d.]+)M/);
  const lvl = parseInt(level.stdout, 10);
  const freePct = parseInt((mp.stdout.match(/free percentage: (\d+)%/) || [])[1] || "0", 10);
  return {
    total,
    used: app + wired + compressed,
    app,
    wired,
    compressed,
    compressedLogical: v["Pages stored in compressor"] || 0,
    cached,
    swapTotal: sw ? parseFloat(sw[1]) * 1024 * 1024 : 0,
    swapUsed: sw ? parseFloat(sw[2]) * 1024 * 1024 : 0,
    pressure: lvl >= 4 ? "high" : lvl >= 2 ? "medium" : "normal",
    pressureLevelRaw: lvl,
    freePercent: freePct,
  };
}

/** One snapshot of every process: identity, parent, age, CPU, footprint and compressed size. */
export async function processSnapshot() {
  const [ps, args, top] = await Promise.all([
    run("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,lstart=,comm="]),
    run("/bin/ps", ["-axo", "pid=,args="]),
    run("/usr/bin/top", ["-l", "1", "-stats", "pid,mem,cmprs"], { timeout: 30_000 }),
  ]);
  const procs = new Map();
  for (const line of ps.stdout.split("\n")) {
    // lstart is always 5 words: "Wed Nov 12 16:55:01 2026"
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1];
    const started = new Date(m[4]).getTime();
    procs.set(pid, { pid, ppid: +m[2], cpu: +m[3], lstart: m[4].replace(/\s+/g, " "), startedAt: started, ageSec: Math.max(0, Math.round((Date.now() - started) / 1000)), comm: m[5], name: path.basename(m[5]), args: "", footprint: 0, compressed: 0, children: [] });
  }
  for (const line of args.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s(.*)$/);
    if (m && procs.has(+m[1])) procs.get(+m[1]).args = m[2];
  }
  for (const line of top.stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)$/);
    if (m && procs.has(+m[1])) {
      const p = procs.get(+m[1]);
      p.footprint = parseSize(m[2]);
      p.compressed = parseSize(m[3]);
    }
  }
  for (const p of procs.values()) if (procs.has(p.ppid) && p.ppid !== p.pid) procs.get(p.ppid).children.push(p.pid);
  return procs;
}

function descendants(procs, pid) {
  const out = [];
  const stack = [...(procs.get(pid)?.children || [])];
  while (stack.length) {
    const c = stack.pop();
    out.push(c);
    stack.push(...(procs.get(c)?.children || []));
  }
  return out;
}

function ancestors(procs, pid) {
  const out = [];
  let p = procs.get(pid);
  while (p && p.ppid && p.ppid !== p.pid && out.length < 50) {
    out.push(p.ppid);
    p = procs.get(p.ppid);
  }
  return out;
}

function appOf(comm) {
  const i = comm.indexOf(".app/");
  if (i < 0) return null;
  const bundlePath = comm.slice(0, i + 4);
  return { name: path.basename(bundlePath, ".app"), bundlePath };
}

/** Group processes by the outermost app bundle they belong to. */
export function groupByApp(procs) {
  const self = new Set([process.pid, ...ancestors(procs, process.pid)]);
  const groups = new Map();
  for (const p of procs.values()) {
    const app = appOf(p.comm);
    const key = app ? app.bundlePath : p.name;
    if (!groups.has(key)) {
      const quittable = !!app && APP_DIRS.some((d) => app.bundlePath.startsWith(d)) && !app.bundlePath.includes(".app/Contents/");
      const name = app ? app.name : /^next-server/.test(p.args) ? "Next.js server" : p.name;
      groups.set(key, { key, name, bundlePath: app?.bundlePath || null, quittable, footprint: 0, compressed: 0, count: 0, cpu: 0, pids: [] });
    }
    const g = groups.get(key);
    g.footprint += p.footprint;
    g.compressed += p.compressed;
    g.cpu += p.cpu;
    g.count += 1;
    g.pids.push(p.pid);
    if (self.has(p.pid)) g.containsThisTool = true;
  }
  return [...groups.values()].sort((a, b) => b.footprint - a.footprint);
}

async function bootedSimulators(procs) {
  const r = await run("/usr/bin/xcrun", ["simctl", "list", "devices", "booted", "-j"], { timeout: 30_000 });
  if (!r.ok) return { available: false, devices: [] };
  const data = JSON.parse(r.stdout);
  const devices = [];
  for (const [runtime, list] of Object.entries(data.devices || {})) {
    for (const d of list) {
      if (d.state !== "Booted") continue;
      const launchd = [...procs.values()].find((p) => p.name === "launchd_sim" && p.args.includes(d.udid));
      const tree = launchd ? [launchd.pid, ...descendants(procs, launchd.pid)] : [];
      const footprint = tree.reduce((s, pid) => s + (procs.get(pid)?.footprint || 0), 0);
      devices.push({ udid: d.udid, name: d.name, runtime: runtime.replace(/^.*SimRuntime\./, "").replace(/-/g, " ").replace(/^(iOS|watchOS|tvOS|xrOS|visionOS) (\d+) (\d+)/, "$1 $2.$3"), footprint, processCount: tree.length });
    }
  }
  return { available: true, devices };
}

function idleDebuggers(procs) {
  const out = [];
  for (const p of procs.values()) {
    if (p.name !== "lldb-rpc-server") continue;
    const kids = descendants(procs, p.pid).map((c) => procs.get(c)).filter(Boolean);
    const debugging = kids.some((k) => k.name.includes("debugserver"));
    out.push({ pid: p.pid, lstart: p.lstart, ageSec: p.ageSec, cpu: p.cpu, footprint: p.footprint, idle: !debugging, parent: procs.get(p.ppid)?.name || "?" });
  }
  return out.sort((a, b) => b.footprint - a.footprint);
}

function describeNode(args) {
  if (/next-server|next\/dist\/bin\/next|\bnext (dev|start)/.test(args)) return "Next.js dev server";
  if (/\bvite\b/.test(args)) return "Vite dev server";
  if (/webpack/.test(args)) return "Webpack build helper";
  if (/\b(npm|pnpm|yarn)\b.*\b(run|dev|start|exec)\b/.test(args)) return "Package script";
  if (/mcp/i.test(args)) return "Tool server for an AI assistant";
  if (/storybook/.test(args)) return "Storybook";
  return "Node program";
}

async function devServers(procs) {
  const isRuntime = (p) => p && (DEV_RUNTIMES.has(p.name) || /^next-server/.test(p.args));
  const roots = new Map();
  const self = new Set([process.pid, ...ancestors(procs, process.pid), ...descendants(procs, process.pid)]);
  for (const p of procs.values()) {
    if (!isRuntime(p) || self.has(p.pid)) continue;
    let root = p;
    while (isRuntime(procs.get(root.ppid)) && !self.has(root.ppid)) root = procs.get(root.ppid);
    if (!roots.has(root.pid)) roots.set(root.pid, root);
  }
  const list = [...roots.values()];
  if (!list.length) return [];
  const allPids = list.flatMap((r) => [r.pid, ...descendants(procs, r.pid)]);
  const [ports, cwds] = await Promise.all([
    run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn", "-a", "-p", allPids.join(",")], { timeout: 20_000 }),
    run("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fpn", "-p", list.map((r) => r.pid).join(",")], { timeout: 20_000 }),
  ]);
  const portsByPid = new Map();
  let cur = null;
  for (const line of ports.stdout.split("\n")) {
    if (line.startsWith("p")) cur = +line.slice(1);
    else if (line.startsWith("n") && cur) {
      const port = line.slice(1).split(":").pop();
      if (!portsByPid.has(cur)) portsByPid.set(cur, new Set());
      portsByPid.get(cur).add(port);
    }
  }
  const cwdByPid = new Map();
  cur = null;
  for (const line of cwds.stdout.split("\n")) {
    if (line.startsWith("p")) cur = +line.slice(1);
    else if (line.startsWith("n") && cur) cwdByPid.set(cur, line.slice(1));
  }
  return list
    .map((r) => {
      const tree = [r.pid, ...descendants(procs, r.pid)];
      const portSet = new Set();
      tree.forEach((pid) => portsByPid.get(pid)?.forEach((x) => portSet.add(x)));
      const anc = ancestors(procs, r.pid).map((pid) => procs.get(pid)).filter(Boolean);
      // Started by Claude, or living in Claude's own folders (scratch servers of other sessions).
      const viaClaude = anc.some((a) => a.name === "claude" || /Claude\.app\//.test(a.comm)) || /\/claude-\d+\/|Application Support\/Claude\//.test(`${cwdByPid.get(r.pid) || ""} ${r.args}`);
      const kind = describeNode(tree.map((pid) => procs.get(pid)?.args || "").join(" "));
      return {
        pid: r.pid,
        lstart: r.lstart,
        kind,
        args: r.args,
        cwd: tilde(cwdByPid.get(r.pid) || ""),
        ports: [...portSet].sort(),
        ageSec: r.ageSec,
        footprint: tree.reduce((s, pid) => s + (procs.get(pid)?.footprint || 0), 0),
        processCount: tree.length,
        startedBy: viaClaude ? "claude" : anc[0]?.name || "?",
        pids: tree,
        likelyDevServer: portSet.size > 0 || /dev server|Storybook|Package script/.test(kind),
      };
    })
    .sort((a, b) => b.footprint - a.footprint);
}

export async function ramReport() {
  const [overview, procs] = await Promise.all([memoryOverview(), processSnapshot()]);
  const [sims, servers] = await Promise.all([bootedSimulators(procs), devServers(procs)]);
  const groups = groupByApp(procs);
  // macOS reports per app only "compressed or swapped" as one number. Split it with the
  // Mac-wide ratio of swap to compressor memory: an estimate, labelled as such on the page.
  const swapShare = overview.swapUsed + overview.compressed > 0 ? overview.swapUsed / (overview.swapUsed + overview.compressed) : 0;
  overview.swapShare = swapShare;
  return {
    overview,
    apps: groups.slice(0, 25).map(({ pids, ...g }) => {
      const set = new Set(pids);
      const stoppable = servers.filter((sv) => sv.pids.some((pid) => set.has(pid)));
      return {
        ...g,
        inRam: Math.max(0, g.footprint - g.compressed),
        estSwap: Math.round(g.compressed * swapShare),
        estCompressed: Math.round(g.compressed * (1 - swapShare)),
        devServerPids: g.quittable ? [] : stoppable.map((sv) => sv.pid),
        stopLabel: stoppable.length ? stoppable.map((sv) => sv.kind).join(", ") : null,
      };
    }),
    simulators: sims,
    debuggers: idleDebuggers(procs),
    devServers: servers,
    takenAt: Date.now(),
  };
}

// ---------- plans ----------

async function waitForExit(pids, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const alive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive.length) return [];
    await new Promise((r) => setTimeout(r, 200));
  }
  return pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

/** Start time of just these processes (cheap identity check before signalling). */
async function startTimes(pids) {
  const r = await run("/bin/ps", ["-o", "pid=,lstart=", "-p", pids.join(",")]);
  const out = new Map();
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m) out.set(+m[1], m[2].replace(/\s+/g, " "));
  }
  return out;
}

function stopStep(label, pids, lstartByPid, bytes = 0) {
  return {
    label,
    bytes,
    command: `kill -TERM ${pids.join(" ")}`,
    run: async () => {
      // Re-check identity right before stopping: a reused process number is never signalled.
      const now = await startTimes(pids);
      const targets = pids.filter((pid) => now.get(pid) === lstartByPid.get(pid));
      if (!targets.length) return { ok: true, message: "Already stopped." };
      for (const pid of targets) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* gone */
        }
      }
      const left = await waitForExit(targets);
      return left.length ? { ok: false, message: `Still running after a polite stop: ${left.join(", ")}. Try again or quit it from its own window.` } : { ok: true, message: "Stopped." };
    },
  };
}

// Each builder returns { steps, warnings, bytes } so single actions and the smart clean-up share them.

async function simulatorSteps(procs, udids) {
  const { devices } = await bootedSimulators(procs);
  const chosen = devices.filter((d) => udids.includes(d.udid));
  return {
    bytes: chosen.reduce((s, d) => s + d.footprint, 0),
    warnings: chosen.length ? ["Apps running in those simulators stop. Their apps and data stay on disk."] : [],
    steps: chosen.map((d) => ({
      label: `Shut down simulator ${d.name} (${d.runtime})`,
      bytes: d.footprint,
      command: cmdline("xcrun", ["simctl", "shutdown", d.udid]),
      run: async () => {
        const r = await run("/usr/bin/xcrun", ["simctl", "shutdown", d.udid], { timeout: 120_000 });
        return { ok: r.ok || /current state: Shutdown/.test(r.stderr), message: r.ok ? "Shut down." : r.stderr };
      },
    })),
  };
}

function debuggerSteps(procs, pids) {
  const chosen = idleDebuggers(procs).filter((d) => d.idle && pids.includes(d.pid));
  if (!chosen.length) return { steps: [], warnings: [], bytes: 0 };
  return {
    bytes: chosen.reduce((s, d) => s + d.footprint, 0),
    warnings: ["If you are debugging an app on a real iPhone right now, its debugger helper looks idle here. Stop the debug session in Xcode first, or skip it."],
    steps: [stopStep(`Stop ${chosen.length} idle debugger helper${chosen.length > 1 ? "s" : ""}`, chosen.map((d) => d.pid), new Map(chosen.map((d) => [d.pid, d.lstart])), chosen.reduce((s, d) => s + d.footprint, 0))],
  };
}

async function devServerSteps(procs, pids) {
  const chosen = (await devServers(procs)).filter((s) => pids.includes(s.pid));
  const warnings = chosen.length ? ["Pages served by those programs stop loading until you start them again."] : [];
  if (chosen.some((s) => s.startedBy === "claude")) warnings.push("Some were started by Claude. Stopping them can break a running Claude session's tools.");
  return {
    bytes: chosen.reduce((s, d) => s + d.footprint, 0),
    warnings,
    steps: chosen.map((s) => {
      const tree = [s.pid, ...descendants(procs, s.pid)];
      return stopStep(`Stop ${s.kind}${s.cwd ? ` in ${s.cwd}` : ""}${s.ports.length ? ` (port ${s.ports.join(", ")})` : ""}`, tree, new Map(tree.map((pid) => [pid, procs.get(pid).lstart])), s.footprint);
    }),
  };
}

async function appSteps(procs, keys) {
  const groups = groupByApp(procs).filter((g) => g.quittable && keys.includes(g.key));
  const steps = [];
  const warnings = groups.length ? ["Apps get a normal Quit, so they can ask you to save. Nothing is force quit."] : [];
  for (const g of groups) {
    const idr = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", `${g.bundlePath}/Contents/Info.plist`]);
    const bundleId = idr.stdout.trim();
    if (!bundleId) continue;
    if (/claude/i.test(bundleId)) warnings.push("Quitting Claude closes every Claude session on this Mac, including any that is working now.");
    if (g.containsThisTool) warnings.push(`${g.name} is running this cleaner. Quitting it closes this page's server.`);
    const script = `with timeout of 20 seconds\ntell application id "${bundleId}" to quit\nend timeout`;
    steps.push({
      label: `Quit ${g.name}`,
      bytes: g.footprint,
      command: cmdline("osascript", ["-e", script]),
      run: async () => {
        const r = await run("/usr/bin/osascript", ["-e", script], { timeout: 30_000 });
        if (!r.ok && /-1743|not allowed/i.test(r.stderr)) return { ok: false, message: "macOS blocked this. Allow it in System Settings → Privacy & Security → Automation, then try again." };
        // Quitting can pause on a question in the app (unsaved work, a running build). Check it really closed.
        const main = g.pids.map((pid) => procs.get(pid)).find((p) => p && p.comm.startsWith(`${g.bundlePath}/Contents/MacOS/`));
        const left = main ? await waitForExit([main.pid], 8000) : [];
        if (left.length) return { ok: false, message: `${g.name} is still open. It's probably waiting for you to answer a question in its window (save changes, stop a running build). Answer it there, or quit it yourself.` };
        if (!r.ok) return { ok: false, message: r.stderr };
        return { ok: true, message: "Quit." };
      },
    });
  }
  return { steps, warnings, bytes: steps.reduce((s, x) => s + x.bytes, 0) };
}

function chromeTabStep(tabs, chromeBytes) {
  if (!tabs?.running || tabs.error || tabs.tabs <= 1) return { steps: [], warnings: [], bytes: 0 };
  return {
    bytes: 0,
    warnings: [`Chrome closes ${tabs.tabs - 1} tab${tabs.tabs - 1 > 1 ? "s" : ""} and keeps "${tabs.keep?.title || "the tab in front"}". The list of closed tabs is saved; reopen them from the Memory page.`],
    steps: [{ label: `Close ${tabs.tabs - 1} Chrome tabs, keep "${tabs.keep?.title || "the tab in front"}"`, bytes: 0, command: "osascript -l JavaScript (close every tab except the active tab of the front window)", run: closeOtherTabs, estimate: chromeBytes }],
  };
}

export async function planRam(kind, ids = []) {
  const procs = await processSnapshot();
  const built =
    kind === "simulators" ? await simulatorSteps(procs, ids) : kind === "debuggers" ? debuggerSteps(procs, ids) : kind === "devServers" ? await devServerSteps(procs, ids) : kind === "apps" ? await appSteps(procs, ids) : null;
  if (!built) throw new Error("Unknown action");
  if (!built.steps.length) throw new Error("None of the chosen items are running now.");
  const titles = { simulators: "Shut down simulators", debuggers: "Stop idle debugger helpers", devServers: "Stop Node programs", apps: "Quit apps" };
  const summaries = {
    simulators: "Each simulator closes like it was turned off. You can start it again from Xcode.",
    debuggers: "Xcode starts a debugger helper (lldb-rpc-server) for each debug session and sometimes leaves it running. These aren't debugging anything on this Mac.",
    devServers: "Each program gets a polite stop request, the same as pressing Control-C in its terminal.",
    apps: "Each app is asked to quit, like choosing Quit from its menu.",
  };
  return makePlan({ title: `${titles[kind]} (${built.steps.length})`, summary: `${summaries[kind]} Frees about ${fmt(built.bytes)}.`, warnings: built.warnings, steps: built.steps, reclaimBytes: built.bytes });
}

// ---------- smart clean-up ----------

// Apps kept open by default. The person can add or remove apps; that choice is saved.
export const DEFAULT_KEEP = ["Claude", "Google Chrome", "Safari", "Arc", "Firefox", "Finder", "Terminal", "iTerm", "Warp", "Ghostty", "Xcode", "Simulator", "System Settings", "Activity Monitor", "1Password", "Visual Studio Code", "Cursor"];
const KEEP_FILE = "keep-apps.json";

export function keepList() {
  const saved = readState(KEEP_FILE, { add: [], remove: [] });
  return new Set([...DEFAULT_KEEP.filter((n) => !saved.remove.includes(n)), ...saved.add]);
}

export function setKeep(name, keep) {
  const saved = readState(KEEP_FILE, { add: [], remove: [] });
  saved.add = saved.add.filter((n) => n !== name);
  saved.remove = saved.remove.filter((n) => n !== name);
  if (keep && !DEFAULT_KEEP.includes(name)) saved.add.push(name);
  if (!keep && DEFAULT_KEEP.includes(name)) saved.remove.push(name);
  writeState(KEEP_FILE, saved);
  return { keep: [...keepList()] };
}

/** What a one-click clean-up would do right now, with sensible defaults ticked. */
export async function smartCandidates() {
  const [procs, tabs] = await Promise.all([processSnapshot(), chromeTabs()]);
  const [sims, servers] = await Promise.all([bootedSimulators(procs), devServers(procs)]);
  const keep = keepList();
  const groups = groupByApp(procs);
  const chrome = groups.find((g) => g.name === "Google Chrome");
  return {
    simulators: sims.devices.map((d) => ({ id: d.udid, name: `${d.name} (${d.runtime})`, bytes: d.footprint, checked: true })),
    debuggers: idleDebuggers(procs)
      .filter((d) => d.idle)
      .map((d) => ({ id: d.pid, name: `Debugger helper, running ${Math.round(d.ageSec / 60)} min`, bytes: d.footprint, checked: true })),
    devServers: servers
      .filter((s) => s.startedBy !== "claude" && (s.likelyDevServer || s.footprint > 200 * 1024 * 1024))
      .map((s) => ({ id: s.pid, name: `${s.kind}${s.cwd ? ` in ${s.cwd}` : ""}${s.ports.length ? ` (port ${s.ports.join(", ")})` : ""}`, ageSec: s.ageSec, bytes: s.footprint, checked: s.ageSec >= 3600 })),
    apps: groups
      .filter((g) => g.quittable && !g.containsThisTool)
      .map((g) => ({ id: g.key, name: g.name, bytes: g.footprint, kept: keep.has(g.name), checked: !keep.has(g.name) && g.footprint > 150 * 1024 * 1024 }))
      .sort((a, b) => b.bytes - a.bytes),
    chrome: { ...tabs, bytes: chrome?.footprint || 0, checked: !!(tabs.running && !tabs.error && tabs.tabs > 1) },
    keep: [...keep],
  };
}

export async function planSmart({ simulators = [], debuggers = [], devServers: servers = [], apps = [], chromeTabs: closeTabs = false } = {}) {
  const procs = await processSnapshot();
  const parts = [await simulatorSteps(procs, simulators), debuggerSteps(procs, debuggers.map(Number)), await devServerSteps(procs, servers.map(Number))];
  const chrome = groupByApp(procs).find((g) => g.name === "Google Chrome");
  if (closeTabs && !apps.includes(chrome?.key)) parts.push(chromeTabStep(await chromeTabs(), chrome?.footprint || 0));
  parts.push(await appSteps(procs, apps));
  const steps = parts.flatMap((p) => p.steps);
  if (!steps.length) throw new Error("Nothing is selected, or the chosen items already stopped.");
  const bytes = parts.reduce((s, p) => s + p.bytes, 0);
  const tabsPart = steps.some((s) => s.estimate) ? " plus what Chrome's closed tabs used" : "";
  return makePlan({
    title: "Smart clean-up",
    summary: `Frees about ${fmt(bytes)}${tabsPart}. Apps on your keep list stay open.`,
    warnings: [...new Set(parts.flatMap((p) => p.warnings))],
    steps,
    reclaimBytes: bytes,
  });
}

function fmt(b) {
  const u = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) {
    b /= 1000;
    i++;
  }
  return `${i === 0 ? b : b.toFixed(b >= 100 ? 0 : 1)} ${u[i]}`;
}

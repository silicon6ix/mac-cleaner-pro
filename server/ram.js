// Optimize RAM: memory pressure, swap, top apps, and the things that usually eat memory
// on a development Mac (simulators, idle debugger helpers, forgotten dev servers, apps).
import path from "node:path";
import { run, cmdline, tilde, HOME } from "./util.js";
import { makePlan } from "./plans.js";

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
    procs.set(pid, { pid, ppid: +m[2], cpu: +m[3], lstart: m[4], startedAt: started, ageSec: Math.max(0, Math.round((Date.now() - started) / 1000)), comm: m[5], name: path.basename(m[5]), args: "", footprint: 0, compressed: 0, children: [] });
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
      const viaClaude = anc.some((a) => a.name === "claude" || /Claude\.app\//.test(a.comm));
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
        likelyDevServer: portSet.size > 0 || /dev server|Storybook|Package script/.test(kind),
      };
    })
    .sort((a, b) => b.footprint - a.footprint);
}

export async function ramReport() {
  const [overview, procs] = await Promise.all([memoryOverview(), processSnapshot()]);
  const [sims, servers] = await Promise.all([bootedSimulators(procs), devServers(procs)]);
  const groups = groupByApp(procs);
  return {
    overview,
    apps: groups.slice(0, 25).map(({ pids, ...g }) => g),
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

function stopStep(label, pids, lstartByPid) {
  return {
    label,
    command: `kill -TERM ${pids.join(" ")}`,
    run: async () => {
      // Re-check identity right before stopping: a reused process number is never signalled.
      const now = await processSnapshot();
      const targets = pids.filter((pid) => now.get(pid)?.lstart === lstartByPid.get(pid));
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

export async function planRam(kind, ids = []) {
  const procs = await processSnapshot();
  if (kind === "simulators") {
    const { devices } = await bootedSimulators(procs);
    const chosen = devices.filter((d) => ids.includes(d.udid));
    if (!chosen.length) throw new Error("None of the chosen simulators are running now.");
    return makePlan({
      title: `Shut down ${chosen.length} simulator${chosen.length > 1 ? "s" : ""}`,
      summary: "Each simulator closes like it was turned off. Its apps and data stay on disk, and you can start it again from Xcode.",
      warnings: ["Any app you are running in these simulators stops."],
      steps: chosen.map((d) => ({
        label: `Shut down ${d.name} (${d.runtime})`,
        command: cmdline("xcrun", ["simctl", "shutdown", d.udid]),
        run: async () => {
          const r = await run("/usr/bin/xcrun", ["simctl", "shutdown", d.udid], { timeout: 120_000 });
          return { ok: r.ok || /current state: Shutdown/.test(r.stderr), message: r.ok ? "Shut down." : r.stderr };
        },
      })),
    });
  }
  if (kind === "debuggers") {
    const chosen = idleDebuggers(procs).filter((d) => d.idle && ids.includes(d.pid));
    if (!chosen.length) throw new Error("None of the chosen debugger helpers are idle now.");
    return makePlan({
      title: `Stop ${chosen.length} idle debugger helper${chosen.length > 1 ? "s" : ""}`,
      summary: "Xcode starts a debugger helper (lldb-rpc-server) for each debug session and sometimes leaves it running. These ones are not debugging anything on this Mac.",
      warnings: ["If you are debugging an app on a real iPhone right now, the helper looks idle here. Stop the debug session in Xcode first, or skip this."],
      steps: [stopStep(`Stop debugger helper${chosen.length > 1 ? "s" : ""}`, chosen.map((d) => d.pid), new Map(chosen.map((d) => [d.pid, d.lstart])))],
    });
  }
  if (kind === "devServers") {
    const all = await devServers(procs);
    const chosen = all.filter((s) => ids.includes(s.pid));
    if (!chosen.length) throw new Error("None of the chosen programs are running now.");
    const warnings = ["Pages served by these programs stop loading until you start them again."];
    if (chosen.some((s) => s.startedBy === "claude")) warnings.push("Some of these were started by Claude. Stopping them can break a running Claude session's tools.");
    return makePlan({
      title: `Stop ${chosen.length} Node program${chosen.length > 1 ? "s" : ""}`,
      summary: "Each program gets a polite stop request, the same as pressing Control-C in its terminal.",
      warnings,
      steps: chosen.map((s) => {
        const tree = [s.pid, ...descendants(procs, s.pid)];
        return stopStep(`Stop ${s.kind}${s.cwd ? ` in ${s.cwd}` : ""}${s.ports.length ? ` (port ${s.ports.join(", ")})` : ""}`, tree, new Map(tree.map((pid) => [pid, procs.get(pid).lstart])));
      }),
    });
  }
  if (kind === "apps") {
    const groups = groupByApp(procs).filter((g) => g.quittable && ids.includes(g.key));
    if (!groups.length) throw new Error("None of the chosen apps are running now.");
    const steps = [];
    const warnings = ["Apps get a normal Quit, so they can ask you to save. Nothing is force quit."];
    for (const g of groups) {
      const idr = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", `${g.bundlePath}/Contents/Info.plist`]);
      const bundleId = idr.stdout.trim();
      if (!bundleId) continue;
      if (/claude/i.test(bundleId)) warnings.push("Quitting Claude closes every Claude session on this Mac, including any that is working now.");
      if (g.containsThisTool) warnings.push(`${g.name} is running this cleaner. Quitting it closes this page's server.`);
      const script = `tell application id "${bundleId}" to quit`;
      steps.push({
        label: `Quit ${g.name}`,
        command: cmdline("osascript", ["-e", script]),
        run: async () => {
          const r = await run("/usr/bin/osascript", ["-e", script], { timeout: 60_000 });
          if (!r.ok) return { ok: false, message: /-1743|not allowed/i.test(r.stderr) ? "macOS blocked this. Allow it in System Settings → Privacy & Security → Automation, then try again." : r.stderr };
          return { ok: true, message: "Asked to quit." };
        },
      });
    }
    if (!steps.length) throw new Error("Couldn't find these apps' bundle ids.");
    return makePlan({ title: `Quit ${steps.length} app${steps.length > 1 ? "s" : ""}`, summary: "Each app is asked to quit, like choosing Quit from its menu.", warnings, steps });
  }
  throw new Error("Unknown action");
}

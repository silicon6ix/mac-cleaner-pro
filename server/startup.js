// Optimize startup: login items, launch agents and launch daemons, with turn off / turn on / undo
// for the person's own agents (~/Library/LaunchAgents). Everything else gets a command to copy.
import path from "node:path";
import { run, cmdline, tilde, HOME, UID, listDir, readPlist, newId, exists } from "./util.js";
import { makePlan } from "./plans.js";
import { readState, writeState } from "./config.js";

const DIRS = [
  { dir: `${HOME}/Library/LaunchAgents`, scope: "user", title: "Your launch agents", domain: `gui/${UID}` },
  { dir: "/Library/LaunchAgents", scope: "allUsersAgent", title: "Launch agents for all users", domain: `gui/${UID}` },
  { dir: "/Library/LaunchDaemons", scope: "system", title: "Launch daemons (system)", domain: "system" },
];

const UNDO_FILE = "startup-undo.json";

function parseBtm(text) {
  const sections = text.split(/^=+\n Records for UID /m);
  const mine = sections.find((s) => s.startsWith(`${UID} `));
  if (!mine) return [];
  const items = [];
  for (const block of mine.split(/^ #\d+:\n/m).slice(1)) {
    const f = {};
    for (const line of block.split("\n")) {
      const m = line.match(/^\s+([A-Za-z .]+?):\s(.*)$/);
      if (m) f[m[1].trim()] = m[2].trim();
    }
    const type = (f.Type || "").replace(/\s*\(0x[0-9a-f]+\)/, "");
    const disp = f.Disposition || "";
    items.push({
      name: f.Name && f.Name !== "(null)" ? f.Name : null,
      developer: f["Developer Name"] && f["Developer Name"] !== "(null)" ? f["Developer Name"] : null,
      type,
      enabled: /\benabled\b/.test(disp),
      allowed: /\ballowed\b/.test(disp) && !/disallowed/.test(disp),
      identifier: (f.Identifier || "").replace(/^\d+\./, ""),
      url: f.URL && f.URL !== "(null)" ? decodeURIComponent(f.URL.replace(/^file:\/\//, "")) : null,
      executable: f["Executable Path"] || null,
      bundleId: f["Bundle Identifier"] || null,
    });
  }
  return items;
}

function describeProgram(plist) {
  const args = plist.ProgramArguments || (plist.Program ? [plist.Program] : []);
  const program = plist.Program || args[0] || "";
  return { program, commandLine: args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") };
}

function whenItRuns(p) {
  const parts = [];
  if (p.RunAtLoad) parts.push("at login");
  if (p.KeepAlive) parts.push("kept running all the time");
  if (p.StartInterval) parts.push(`every ${Math.round(p.StartInterval / 60)} min`);
  if (p.StartCalendarInterval) parts.push("on a schedule");
  if (p.WatchPaths || p.QueueDirectories) parts.push("when files change");
  if (p.MachServices || p.Sockets) parts.push("when another program asks for it");
  return parts.length ? parts.join(", ") : "only when asked";
}

function friendlyName(label, program) {
  const known = [
    [/^com\.google\.(keystone|GoogleUpdater)/i, "Google updater"],
    [/^com\.adobe\.ARMDC/i, "Adobe Acrobat updater"],
    [/^homebrew\.mxcl\.(.+)/, (m) => `${m[1]} (Homebrew service)`],
    [/^com\.jetbrains\.toolbox/, "JetBrains Toolbox"],
    [/^com\.epicgames/, "Epic Games Launcher"],
    [/^com\.valvesoftware/, "Steam helper"],
    [/^us\.zoom/, "Zoom helper"],
    [/geocomply/i, "GeoComply location check"],
    [/^com\.barco\.clickshare/, "ClickShare"],
    [/^com\.xk72\.charles/, "Charles Proxy helper"],
  ];
  for (const [re, name] of known) {
    const m = label.match(re);
    if (m) return typeof name === "function" ? name(m) : name;
  }
  const app = program.match(/\/([^/]+)\.app\//);
  return app ? app[1] : label;
}

export async function startupReport() {
  const [btmRaw, gui, disabledGui, disabledSys, ps] = await Promise.all([
    run("/usr/bin/sfltool", ["dumpbtm"], { timeout: 30_000 }),
    run("/bin/launchctl", ["list"]),
    run("/bin/launchctl", ["print-disabled", `gui/${UID}`]),
    run("/bin/launchctl", ["print-disabled", "system"]),
    run("/bin/ps", ["-axo", "pid=,comm="]),
  ]);
  const btm = btmRaw.ok ? parseBtm(btmRaw.stdout) : [];
  const loaded = new Map();
  for (const line of gui.stdout.split("\n").slice(1)) {
    const [pid, status, label] = line.split("\t");
    if (label) loaded.set(label, { pid: pid === "-" ? null : +pid, status });
  }
  const disabledMap = (t) => new Map([...t.matchAll(/"([^"]+)" => (enabled|disabled)/g)].map((m) => [m[1], m[2] === "disabled"]));
  const dGui = disabledMap(disabledGui.stdout);
  const dSys = disabledMap(disabledSys.stdout);
  const running = new Set(ps.stdout.split("\n").map((l) => l.trim().replace(/^\d+\s+/, "")));
  const btmByPlist = new Map(btm.filter((b) => b.url && b.url.endsWith(".plist")).map((b) => [b.url, b]));

  const groups = [];
  for (const d of DIRS) {
    const items = [];
    for (const e of await listDir(d.dir)) {
      if (!e.name.endsWith(".plist")) continue;
      const file = path.join(d.dir, e.name);
      const p = (await readPlist(file)) || {};
      const label = p.Label || e.name.replace(/\.plist$/, "");
      const { program, commandLine } = describeProgram(p);
      const overrides = d.scope === "system" ? dSys : dGui;
      const disabled = overrides.has(label) ? overrides.get(label) : !!p.Disabled;
      const isLoaded = d.scope !== "system" ? loaded.has(label) : null;
      const isRunning = (isLoaded && loaded.get(label)?.pid) || (program && running.has(program)) ? true : false;
      const b = btmByPlist.get(file);
      items.push({
        id: `${d.scope}:${label}`,
        label,
        name: friendlyName(label, program),
        file: tilde(file),
        program: tilde(program),
        commandLine,
        when: whenItRuns(p),
        disabled,
        loaded: isLoaded,
        running: isRunning,
        blockedInSettings: b ? !b.allowed : false,
        developer: b?.developer || null,
        scope: d.scope,
        canToggle: d.scope === "user",
        adminCommands: d.scope === "user" ? [] : commandsFor(d, label, file, disabled),
        programMissing: program ? !(await exists(program)) : false,
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({ scope: d.scope, title: d.title, folder: tilde(d.dir), items });
  }

  const loginItems = btm
    .filter((b) => ["app", "login item", "agent", "daemon"].includes(b.type))
    .map((b) => ({ name: b.name || b.identifier, developer: b.developer, type: b.type === "app" ? "App" : b.type === "login item" ? "Opens at login" : b.type === "agent" ? "Background helper" : "System helper", on: b.enabled && b.allowed, path: tilde(b.url || b.executable || ""), identifier: b.identifier }))
    .sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name));

  return { loginItems, loginItemsAvailable: btmRaw.ok, groups, undo: readState(UNDO_FILE, []).slice(-20).reverse() };
}

function commandsFor(d, label, file, disabled) {
  const sudo = d.scope === "system" ? "sudo " : "";
  if (disabled) return [`${sudo}launchctl enable ${d.domain}/${label}`, `${sudo}launchctl bootstrap ${d.domain} ${cmdline(file, []).trim()}`];
  return [`${sudo}launchctl bootout ${d.domain}/${label}`, `${sudo}launchctl disable ${d.domain}/${label}`];
}

async function findUserAgent(label) {
  const report = await startupReport();
  return report.groups.find((g) => g.scope === "user").items.find((i) => i.label === label);
}

const domain = `gui/${UID}`;
const lc = async (args) => {
  const r = await run("/bin/launchctl", args, { timeout: 30_000 });
  return r;
};

export async function planStartup(action, { label, undoId } = {}) {
  if (action === "turnOff" || action === "turnOn") {
    const item = await findUserAgent(label);
    if (!item) throw new Error("Only your own launch agents can be changed here.");
    const file = item.file.replace(/^~/, HOME);
    const entry = { id: newId("u_"), label, name: item.name, file, at: Date.now(), action, wasLoaded: !!item.loaded, wasDisabled: !!item.disabled };
    const steps = [];
    if (action === "turnOff") {
      if (item.loaded) steps.push({ label: `Stop ${item.name} now`, command: `launchctl bootout ${domain}/${label}`, run: async () => okish(await lc(["bootout", `${domain}/${label}`]), /No such process|Could not find/) });
      steps.push({ label: `Keep ${item.name} from starting again`, command: `launchctl disable ${domain}/${label}`, run: async () => okish(await lc(["disable", `${domain}/${label}`])) });
    } else {
      steps.push({ label: `Allow ${item.name} to start`, command: `launchctl enable ${domain}/${label}`, run: async () => okish(await lc(["enable", `${domain}/${label}`])) });
      steps.push({ label: `Start ${item.name} now`, command: `launchctl bootstrap ${domain} ${cmdline(file, [])}`, run: async () => okish(await lc(["bootstrap", domain, file]), /already|Bootstrap failed: 5|service already loaded/i) });
    }
    return makePlan({
      title: `${action === "turnOff" ? "Turn off" : "Turn on"} ${item.name}`,
      summary: action === "turnOff" ? `${item.name} stops now and won't start at login. The file stays where it is, so you can turn it back on here.` : `${item.name} is allowed to start again and starts now.`,
      warnings: action === "turnOff" && /postgres|mysql|redis|mongo/i.test(label) ? ["This is a database your projects may use. They can't connect until you turn it back on."] : [],
      undoable: true,
      steps,
      afterRun: (results) => {
        if (results.every((r) => r.ok)) writeState(UNDO_FILE, [...readState(UNDO_FILE, []), entry].slice(-50));
      },
    });
  }
  if (action === "undo") {
    const history = readState(UNDO_FILE, []);
    const entry = history.find((h) => h.id === undoId);
    if (!entry) throw new Error("That change is no longer in the undo list.");
    const steps = [];
    if (entry.action === "turnOff") {
      if (!entry.wasDisabled) steps.push({ label: `Allow ${entry.name} to start`, command: `launchctl enable ${domain}/${entry.label}`, run: async () => okish(await lc(["enable", `${domain}/${entry.label}`])) });
      if (entry.wasLoaded) steps.push({ label: `Start ${entry.name} again`, command: `launchctl bootstrap ${domain} ${cmdline(entry.file, [])}`, run: async () => okish(await lc(["bootstrap", domain, entry.file]), /already|Bootstrap failed: 5/i) });
    } else {
      if (!entry.wasLoaded) steps.push({ label: `Stop ${entry.name}`, command: `launchctl bootout ${domain}/${entry.label}`, run: async () => okish(await lc(["bootout", `${domain}/${entry.label}`]), /No such process|Could not find/) });
      if (entry.wasDisabled) steps.push({ label: `Keep ${entry.name} off`, command: `launchctl disable ${domain}/${entry.label}`, run: async () => okish(await lc(["disable", `${domain}/${entry.label}`])) });
    }
    if (!steps.length) steps.push({ label: "Nothing to change back", command: "(none)", run: async () => ({ ok: true }) });
    return makePlan({
      title: `Undo: ${entry.action === "turnOff" ? "turn off" : "turn on"} ${entry.name}`,
      summary: `Puts ${entry.name} back the way it was before ${new Date(entry.at).toLocaleString()}.`,
      steps,
      afterRun: (results) => {
        if (results.every((r) => r.ok)) writeState(UNDO_FILE, readState(UNDO_FILE, []).filter((h) => h.id !== undoId));
      },
    });
  }
  if (action === "openSettings") {
    return makePlan({
      title: "Open Login Items in System Settings",
      summary: "Apps that open at login and most background items can only be switched off in System Settings. This opens that page.",
      steps: [{ label: "Open System Settings → General → Login Items", command: "open x-apple.systempreferences:com.apple.LoginItems-Settings.extension", run: async () => okish(await run("/usr/bin/open", ["x-apple.systempreferences:com.apple.LoginItems-Settings.extension"])) }],
    });
  }
  throw new Error("Unknown action");
}

function okish(r, alsoFine) {
  if (r.ok) return { ok: true, message: "Done." };
  if (alsoFine && alsoFine.test(r.stderr + r.stdout)) return { ok: true, message: "Already in that state." };
  return { ok: false, message: r.stderr || r.stdout || `launchctl exited with ${r.code}` };
}

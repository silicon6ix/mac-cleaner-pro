// Mac Cleaner Pro page. Plain JS: fetch data, render, and send every change through a preview.
const TOKEN = document.querySelector('meta[name="token"]').content;
const DRY_FORCED = document.querySelector('meta[name="dry-forced"]').content === "1";
const $ = (s, el = document) => el.querySelector(s);
const main = $("#main");
const modal = $("#modal");

const ICONS = {
  chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
  disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>',
  hammer: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 9l9-4 13 5-9 4z"/><path d="M5 9v12l13 5V14M27 10v12l-9 4"/><path d="M10 12l4 1.5"/></svg>',
  phone: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="3" width="14" height="26" rx="3"/><path d="M14 25h4"/></svg>',
  box: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 10l12-6 12 6-12 6z"/><path d="M4 10v12l12 6 12-6V10M16 16v12"/></svg>',
  grid: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="9" height="9" rx="1.5"/><rect x="19" y="4" width="9" height="9" rx="1.5" transform="rotate(12 23.5 8.5)"/><rect x="4" y="19" width="9" height="9" rx="1.5"/><rect x="19" y="19" width="9" height="9" rx="1.5"/></svg>',
  doc: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M8 3h11l6 6v20H8z"/><path d="M19 3v6h6M12 15h9M12 20h9M12 25h6"/></svg>',
  download: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4v16M10 14l6 6 6-6"/><path d="M5 22v5h22v-5"/></svg>',
  trash: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8h20M12 8V5h8v3M8 8l1.5 20h13L24 8M13 12v12M16 12v12M19 12v12"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="currentColor" opacity=".85"><path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/></svg>',
};
document.querySelectorAll("[data-icon]").forEach((el) => (el.innerHTML = ICONS[el.dataset.icon]));

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function size(b, { parts = false } = {}) {
  if (b == null) return parts ? ["—", ""] : "—";
  const u = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = b;
  while (n >= 1000 && i < u.length - 1) {
    n /= 1000;
    i++;
  }
  const num = i === 0 ? String(n) : n.toFixed(n >= 100 ? 0 : 1);
  return parts ? [num, u[i]] : `${num} ${u[i]}`;
}
function age(sec) {
  if (sec < 90) return `${sec} sec`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  if (sec < 172800) return `${Math.round(sec / 3600)} hours`;
  return `${Math.round(sec / 86400)} days`;
}
async function api(path, body) {
  const res = await fetch(path, { method: body ? "POST" : "GET", headers: { "X-Token": TOKEN, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({ error: "Bad response" }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 3500);
}
const pill = (text, kind = "") => `<span class="pill ${kind}">${esc(text)}</span>`;
const tech = (text, label = "Technical details") => (text ? `<details class="tech"><summary>${label}</summary><pre class="mono">${esc(text)}</pre></details>` : "");

// ---------- state ----------
const state = {
  view: localGet("view") || "disk",
  practice: DRY_FORCED || localGet("practice") === "1",
  ram: null,
  ramSel: { simulators: new Set(), debuggers: new Set(), devServers: new Set(), apps: new Set() },
  minAge: Number(localGet("minAge") || 3600),
  disk: null,
  diskFree: null,
  activeCat: "xcode",
  sel: new Set(),
  unlocked: new Set(),
  touched: new Set(),
  deleteNow: false,
  startup: null,
};
function localGet(k) {
  try {
    return localStorage.getItem("mcp." + k);
  } catch {
    return null;
  }
}
function localSet(k, v) {
  try {
    localStorage.setItem("mcp." + k, v);
  } catch {
    /* private mode */
  }
}

const practice = $("#practice");
practice.checked = state.practice;
practice.disabled = DRY_FORCED;
practice.addEventListener("change", () => {
  state.practice = practice.checked;
  localSet("practice", practice.checked ? "1" : "0");
  render();
});

document.querySelectorAll(".nav").forEach((b) =>
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    localSet("view", state.view);
    render();
    load(state.view);
  })
);

// ---------- plan modal ----------
async function preview(endpoint, body, after) {
  let plan;
  try {
    plan = await api(endpoint, body);
  } catch (e) {
    toast(e.message);
    return;
  }
  const dry = state.practice || plan.dryRunForced;
  modal.innerHTML = `
    <div class="m-head"><h2>${esc(plan.title)}</h2><p>${esc(plan.summary)}</p></div>
    <div class="m-body">
      ${plan.warnings.map((w) => `<div class="m-warn">${esc(w)}</div>`).join("")}
      <b>What will happen</b>
      <ol class="m-steps">${plan.steps.map((s) => `<li>${esc(s.label)}</li>`).join("")}</ol>
      ${tech(plan.steps.map((s) => s.command).join("\n"), "Show the exact commands")}
      ${plan.adminCommands.length ? `<div class="m-admin"><b>Needs admin rights — run these yourself in Terminal:</b><pre class="mono">${esc(plan.adminCommands.join("\n"))}</pre></div>` : ""}
      ${dry ? `<div class="m-warn">Practice mode is on, so this only shows what would happen. Nothing changes.</div>` : ""}
    </div>
    <div class="m-foot">
      <button class="btn" data-act="cancel">Cancel</button>
      ${dry ? "" : `<button class="btn" data-act="dry">Practice run</button>`}
      <button class="btn ${dry ? "primary" : "danger"}" data-act="go">${dry ? "Practice run" : "Yes, do it"}</button>
    </div>`;
  modal.showModal();
  modal.onclick = async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    if (act === "cancel" || act === "close") return modal.close();
    const runDry = act === "dry" || dry;
    modal.querySelectorAll("button").forEach((b) => (b.disabled = true));
    e.target.innerHTML = '<span class="spinner"></span> Working…';
    let res;
    try {
      res = await api("/api/execute", { planId: plan.id, dryRun: runDry });
    } catch (err) {
      res = { ok: false, error: err.message, results: [] };
    }
    showResults(plan, res);
    if (!runDry && after) after(res);
  };
}

function showResults(plan, res) {
  modal.innerHTML = `
    <div class="m-head"><h2>${res.dryRun ? "Practice run finished" : res.ok ? "Done" : "Finished with problems"}</h2>
    <p>${esc(res.error || (res.dryRun ? "Nothing was changed. This is what would have run:" : plan.title))}</p></div>
    <div class="m-body">
      <ol class="m-steps">${(res.results || []).map((r) => `<li class="${r.ok ? "ok" : "fail"}">${esc(r.label)}<div class="result ${r.ok ? "" : "fail"}">${esc(r.message)}</div></li>`).join("")}</ol>
      ${tech((res.results || []).map((r) => r.command).join("\n"), "Show the exact commands")}
    </div>
    <div class="m-foot"><button class="btn primary" data-act="close">OK</button></div>`;
  modal.onclick = (e) => e.target.dataset?.act === "close" && modal.close();
}

function showCommands(title, intro, commands) {
  modal.innerHTML = `
    <div class="m-head"><h2>${esc(title)}</h2><p>${esc(intro)}</p></div>
    <div class="m-body"><div class="m-admin"><pre class="mono">${esc(commands.join("\n"))}</pre></div></div>
    <div class="m-foot"><button class="btn" data-act="copy">Copy</button><button class="btn primary" data-act="close">Close</button></div>`;
  modal.showModal();
  modal.onclick = async (e) => {
    if (e.target.dataset?.act === "copy") {
      await navigator.clipboard.writeText(commands.join("\n")).catch(() => {});
      toast("Copied. Paste it into Terminal.");
    }
    if (e.target.dataset?.act === "close") modal.close();
  };
}

// ---------- RAM ----------
function renderRam() {
  const r = state.ram;
  if (!r) return `<div class="view"><div class="view-head"><div><h1>Memory</h1><p>Reading memory use…</p></div></div><span class="spinner"></span></div>`;
  const o = r.overview;
  const usedPct = (o.used / o.total) * 100;
  const swapPct = o.swapTotal ? (o.swapUsed / o.swapTotal) * 100 : 0;
  const pressureKind = o.pressure === "high" ? "bad" : o.pressure === "medium" ? "warn" : "ok";
  const pressureWord = { normal: "Fine", medium: "Getting tight", high: "Too high" }[o.pressure];
  const sel = state.ramSel;
  const cb = (kind, id, disabled = false) => `<input type="checkbox" class="cb" data-ram="${kind}" data-id="${esc(id)}" ${sel[kind].has(String(id)) ? "checked" : ""} ${disabled ? "disabled" : ""}>`;
  const maxApp = Math.max(...r.apps.map((a) => a.footprint), 1);

  const sims = r.simulators.devices;
  const dbg = r.debuggers;
  const servers = r.devServers.filter((s) => s.ageSec >= state.minAge);
  const devs = servers.filter((s) => s.likelyDevServer && s.startedBy !== "claude");
  const others = servers.filter((s) => !(s.likelyDevServer && s.startedBy !== "claude"));
  const serverRow = (s) => `
    <div class="row">${cb("devServers", s.pid)}
      <div><div class="title">${esc(s.kind)}${s.ports.length ? ` ${pill("port " + s.ports.join(", "), "info")}` : ""}${s.startedBy === "claude" ? ` ${pill("Used by Claude", "warn")}` : ""}</div>
        <div class="sub">${esc(s.cwd || "folder unknown")} · running ${age(s.ageSec)} · ${s.processCount} process${s.processCount > 1 ? "es" : ""}</div>
        ${tech(`pid ${s.pid}\n${s.args}`)}</div>
      <div class="right"><b>${size(s.footprint)}</b></div></div>`;

  return `<div class="view">
    ${state.practice ? `<div class="practice-banner">Practice mode is on. Actions show what they would do and change nothing.</div>` : ""}
    <div class="view-head"><div><h1>Memory</h1><p>What's using your ${size(o.total)} of memory, and quick ways to free some.</p></div>
      <button class="btn" id="ram-refresh">Refresh</button></div>
    <div class="cards">
      <div class="card stat"><div class="label">Memory pressure</div><div class="value">${pressureWord}</div>${pill(`${o.freePercent}% free`, pressureKind)}
        ${tech(`kern.memorystatus_vm_pressure_level = ${o.pressureLevelRaw}\nmemory_pressure -Q free percentage = ${o.freePercent}%`)}</div>
      <div class="card stat"><div class="label">Memory used</div><div class="value">${size(o.used, { parts: true })[0]}<span class="unit">${size(o.used, { parts: true })[1]} of ${size(o.total)}</span></div>
        <div class="meter ${usedPct > 90 ? "bad" : usedPct > 75 ? "warn" : ""}"><span style="width:${usedPct.toFixed(1)}%"></span></div>
        ${tech(`App memory ${size(o.app)}\nWired ${size(o.wired)}\nCompressed ${size(o.compressed)}\nCached files ${size(o.cached)} (freed automatically)`)}</div>
      <div class="card stat"><div class="label">Swap used</div><div class="value">${size(o.swapUsed, { parts: true })[0]}<span class="unit">${size(o.swapUsed, { parts: true })[1]} of ${size(o.swapTotal)}</span></div>
        <div class="meter ${swapPct > 75 ? "bad" : swapPct > 40 ? "warn" : ""}"><span style="width:${swapPct.toFixed(1)}%"></span></div>
        <small>Memory moved to disk because RAM ran out. High swap makes everything slower.</small></div>
      <div class="card stat"><div class="label">Compressed</div><div class="value">${size(o.compressed, { parts: true })[0]}<span class="unit">${size(o.compressed, { parts: true })[1]}</span></div>
        <small>Holding ${size(o.compressedLogical)} of squeezed app data.</small></div>
    </div>

    <div class="section"><div class="section-head"><div><h2>Running iPhone simulators</h2><p>Each running simulator uses about 1–3 GB, even in the background.</p></div>
      <button class="btn primary" data-ram-act="simulators" ${sel.simulators.size ? "" : "disabled"}>Shut down selected</button></div>
      ${!r.simulators.available ? `<div class="empty">Xcode's simulator tools aren't available.</div>` : sims.length ? `<div class="rows">${sims.map((d) => `<div class="row">${cb("simulators", d.udid)}<div><div class="title">${esc(d.name)}</div><div class="sub">${esc(d.runtime)} · ${d.processCount} processes</div>${tech(`udid ${d.udid}`)}</div><div class="right"><b>${size(d.footprint)}</b></div></div>`).join("")}</div>` : `<div class="empty">No simulators are running. 👍</div>`}
    </div>

    <div class="section"><div class="section-head"><div><h2>Idle debugger helpers</h2><p>Xcode sometimes leaves its debugger helper running after a debug session ends.</p></div>
      <button class="btn primary" data-ram-act="debuggers" ${sel.debuggers.size ? "" : "disabled"}>Stop selected</button></div>
      ${dbg.length ? `<div class="rows">${dbg.map((d) => `<div class="row ${d.idle ? "" : "dim"}">${cb("debuggers", d.pid, !d.idle)}<div><div class="title">Debugger helper ${d.idle ? pill("Idle", "warn") : pill("Debugging now", "ok")}</div><div class="sub">Started by ${esc(d.parent)} · running ${age(d.ageSec)} · CPU ${d.cpu.toFixed(1)}%</div>${tech(`lldb-rpc-server pid ${d.pid}${d.idle ? "\nNo debugserver child process on this Mac. Debugging a real iPhone also has no local debugserver, so stop Xcode's debug session first if one is running." : ""}`)}</div><div class="right"><b>${size(d.footprint)}</b></div></div>`).join("")}</div>` : `<div class="empty">No debugger helpers are running.</div>`}
    </div>

    <div class="section"><div class="section-head"><div><h2>Dev servers and Node programs</h2><p>Development servers left running in a terminal keep their memory until you stop them.</p></div>
      <div class="bar"><label class="filter">Running longer than <select id="min-age">${[[0, "any time"], [600, "10 minutes"], [3600, "1 hour"], [86400, "1 day"]].map(([v, l]) => `<option value="${v}" ${state.minAge === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <button class="btn primary" data-ram-act="devServers" ${sel.devServers.size ? "" : "disabled"}>Stop selected</button></div></div>
      ${devs.length ? `<div class="rows">${devs.map(serverRow).join("")}</div>` : `<div class="empty">No dev servers running longer than that.</div>`}
      ${others.length ? `<details class="tech" style="padding:0 16px 12px"><summary>${others.length} other Node program${others.length > 1 ? "s" : ""} (tool helpers, background scripts)</summary><div class="rows">${others.map(serverRow).join("")}</div></details>` : ""}
    </div>

    <div class="section"><div class="section-head"><div><h2>Apps using the most memory</h2><p>Includes memory macOS compressed or moved to swap, so apps you haven't touched in a while still count.
        <span style="white-space:nowrap"><span class="pill info">■ in RAM</span> <span class="pill warn">■ compressed or swap</span></span></p></div>
      <button class="btn primary" data-ram-act="apps" ${sel.apps.size ? "" : "disabled"}>Quit selected</button></div>
      <div class="rows">${r.apps
        .map(
          (a) => `<div class="row">${a.quittable ? cb("apps", a.key) : "<span></span>"}
        <div><div class="title">${esc(a.name)} ${a.containsThisTool ? pill("Runs this cleaner", "info") : ""}</div>
          <div class="bar" style="margin-top:4px"><div class="track2"><div style="display:flex;height:100%;width:${((a.footprint / maxApp) * 100).toFixed(1)}%"><div class="fill" style="flex:${a.footprint - a.compressed}"></div><div class="fill2" style="flex:${a.compressed}"></div></div></div></div>
          <div class="sub">${a.count} process${a.count > 1 ? "es" : ""} · ${size(a.compressed)} compressed or in swap${a.quittable ? "" : " · system or helper, can't quit here"}</div></div>
        <div class="right"><b>${size(a.footprint)}</b></div></div>`
        )
        .join("")}</div>
    </div>
  </div>`;
}

function bindRam() {
  $("#ram-refresh")?.addEventListener("click", () => load("ram", true));
  $("#min-age")?.addEventListener("change", (e) => {
    state.minAge = Number(e.target.value);
    localSet("minAge", e.target.value);
    render();
  });
  main.querySelectorAll("input[data-ram]").forEach((el) =>
    el.addEventListener("change", () => {
      const set = state.ramSel[el.dataset.ram];
      el.checked ? set.add(el.dataset.id) : set.delete(el.dataset.id);
      render();
    })
  );
  main.querySelectorAll("[data-ram-act]").forEach((b) =>
    b.addEventListener("click", () => {
      const kind = b.dataset.ramAct;
      const ids = [...state.ramSel[kind]].map((x) => (kind === "debuggers" || kind === "devServers" ? Number(x) : x));
      preview("/api/plan/ram", { kind, ids }, () => {
        state.ramSel[kind].clear();
        load("ram", true);
      });
    })
  );
}

// ---------- Disk ----------
function allItems() {
  return state.disk ? state.disk.categories.flatMap((c) => c.items) : [];
}
function applyDefaults() {
  // Pre-tick what the scanner suggests, but never undo a choice the person made.
  for (const i of allItems()) {
    if (state.touched.has(i.id)) continue;
    if (i.checked && !i.protected) state.sel.add(i.id);
  }
}
function selectable(i) {
  return !i.protected || state.unlocked.has(i.id);
}

function renderDisk() {
  const scan = state.disk;
  const free = state.diskFree;
  const head = `<div class="view-head"><div><h1>Disk space</h1><p>${free ? `${size(free.free)} free of ${size(free.total)}.` : ""} Tick what to remove. Nothing is removed until you confirm.</p></div>
    <button class="btn" id="disk-scan" ${scan && !scan.done ? "disabled" : ""}>${scan && !scan.done ? '<span class="spinner"></span> Scanning…' : "Scan again"}</button></div>`;
  if (!scan) return `<div class="view">${head}<span class="spinner"></span></div>`;
  const cat = scan.categories.find((c) => c.id === state.activeCat) || scan.categories[0];
  const catTotal = (c) => c.items.reduce((s, i) => s + (i.size || 0), 0);
  const catSel = (c) => c.items.filter((i) => state.sel.has(i.id));
  const total = scan.categories.reduce((s, c) => s + catTotal(c), 0);
  const selBytes = allItems().filter((i) => state.sel.has(i.id) && i.action !== "pnpm-prune").reduce((s, i) => s + (i.size || 0), 0);
  const [selNum, selUnit] = size(selBytes, { parts: true });
  const [totNum, totUnit] = size(total, { parts: true });

  const cats = scan.categories
    .map((c) => {
      const s = catSel(c);
      const selectableItems = c.items.filter(selectable);
      const all = selectableItems.length && s.length === selectableItems.length;
      const busy = c.status === "finding" || c.status === "measuring";
      return `<div class="cat ${c.id === cat.id ? "active" : ""}" data-cat="${c.id}">
        <input type="checkbox" class="cb" data-catcb="${c.id}" ${all ? "checked" : ""} ${!selectableItems.length ? "disabled" : ""} aria-label="Select all in ${esc(c.title)}">
        <span class="cat-ico">${ICONS[c.icon]}</span>
        <span><b>${esc(c.title)}</b><small>${busy ? "Measuring…" : c.status === "error" ? "Couldn't scan" : c.id === "trash" && c.items[0] && !c.items[0].sizeKnown ? "Size unknown" : size(catTotal(c))}</small></span>
        <span>${busy ? '<span class="spinner"></span>' : s.length ? pill(String(s.length)) : ""}</span></div>`;
    })
    .join("");

  const groups = new Map();
  for (const i of cat.items) {
    const g = i.group || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  }
  const itemRow = (i) => {
    const locked = !selectable(i);
    const tagKind = (t) => (t === "In use" || t === "Main project" || t === "Newest" ? "ok" : t === "Stale" || t === "Older version" ? "warn" : "");
    return `<div class="row ${locked ? "dim" : ""}">
      <input type="checkbox" class="cb" data-item="${i.id}" ${state.sel.has(i.id) ? "checked" : ""} ${locked ? "disabled" : ""} aria-label="${esc(i.name)}">
      <span class="folder-ico">${ICONS[i.action === "trash" ? "folder" : cat.icon]}</span>
      <div><div class="title">${esc(i.name)}<span class="tags">${i.tags.map((t) => pill(t, tagKind(t))).join("")}</span></div>
        <div class="sub">${esc(i.detail)}${i.sizeNote ? ` ${esc(i.sizeNote)}` : ""}</div>
        ${i.warn ? `<div class="warnline">${esc(i.warn)}${locked ? ` <button class="link" data-unlock="${i.id}">Unlock</button>` : ""}</div>` : ""}
        ${tech([i.where, i.tech].filter(Boolean).join("\n"))}</div>
      <div class="right">${i.where ? `<button class="link" data-reveal="${esc(i.where)}">Show</button>` : ""}<b>${i.size == null ? (i.action === "empty-trash" ? "?" : '<span class="spinner"></span>') : size(i.size)}</b></div></div>`;
  };
  const detail = `
    <div class="detail-head"><h2>${esc(cat.title)}</h2><p>${esc(cat.blurb)}</p>
      ${cat.note ? `<div class="m-warn">${esc(cat.note)}</div>` : ""}
      <div class="detail-tools"><button class="link" data-selall="${cat.id}">Select all</button><button class="link" data-selnone="${cat.id}">Select none</button><button class="link" data-selsuggested="${cat.id}">Suggested only</button></div></div>
    ${cat.items.length ? [...groups.entries()].map(([g, items]) => `${g ? `<div class="group-title"><span>${esc(g)}</span><span>${size(items.reduce((s, i) => s + (i.size || 0), 0))}</span></div>` : ""}<div class="rows">${items.map(itemRow).join("")}</div>`).join("") : `<div class="empty">${cat.status === "done" ? "Nothing to clean here." : "Looking…"}</div>`}`;

  return `<div class="view disk-view">
    ${state.practice ? `<div class="practice-banner">Practice mode is on. Remove shows what it would do and changes nothing.</div>` : ""}
    ${head}
    <div class="cleaner"><div class="cats">${cats}</div><div class="detail">${detail}</div></div>
    <div class="footer">
      <label title="Frees the space right away. Items can't be put back."><input type="checkbox" id="delete-now" ${state.deleteNow ? "checked" : ""}> Skip the Trash</label>
      <div class="figure sel"><b>${selNum}</b><span>${selUnit}<br>Selected</span></div>
      <div class="divider"></div>
      <div class="figure"><b>${totNum}</b><span>${totUnit}<br>Total</span></div>
      <button class="btn primary big" id="disk-remove" ${state.sel.size && scan.done ? "" : "disabled"}>Remove</button>
    </div>
  </div>`;
}

function bindDisk() {
  $("#disk-scan")?.addEventListener("click", () => scanDisk());
  main.querySelectorAll("[data-cat]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.matches("input")) return;
      state.activeCat = el.dataset.cat;
      render();
    })
  );
  const cat = (id) => state.disk.categories.find((c) => c.id === id);
  const setMany = (items, on) =>
    items.filter(selectable).forEach((i) => {
      state.touched.add(i.id);
      on ? state.sel.add(i.id) : state.sel.delete(i.id);
    });
  main.querySelectorAll("[data-catcb]").forEach((el) => el.addEventListener("change", () => (setMany(cat(el.dataset.catcb).items, el.checked), render())));
  main.querySelectorAll("[data-selall]").forEach((el) => el.addEventListener("click", () => (setMany(cat(el.dataset.selall).items, true), render())));
  main.querySelectorAll("[data-selnone]").forEach((el) => el.addEventListener("click", () => (setMany(cat(el.dataset.selnone).items, false), render())));
  main.querySelectorAll("[data-selsuggested]").forEach((el) =>
    el.addEventListener("click", () => {
      for (const i of cat(el.dataset.selsuggested).items) {
        state.touched.add(i.id);
        i.checked && selectable(i) ? state.sel.add(i.id) : state.sel.delete(i.id);
      }
      render();
    })
  );
  main.querySelectorAll("[data-item]").forEach((el) =>
    el.addEventListener("change", () => {
      state.touched.add(el.dataset.item);
      el.checked ? state.sel.add(el.dataset.item) : state.sel.delete(el.dataset.item);
      render();
    })
  );
  main.querySelectorAll("[data-unlock]").forEach((el) =>
    el.addEventListener("click", () => {
      const item = allItems().find((i) => i.id === el.dataset.unlock);
      if (item && confirm(`Unlock "${item.name}"?\n\n${item.warn}\n\nIt stays unticked until you tick it.`)) {
        state.unlocked.add(item.id);
        render();
      }
    })
  );
  main.querySelectorAll("[data-reveal]").forEach((el) => el.addEventListener("click", () => api("/api/reveal", { path: el.dataset.reveal }).catch((e) => toast(e.message))));
  $("#delete-now")?.addEventListener("change", (e) => (state.deleteNow = e.target.checked));
  $("#disk-remove")?.addEventListener("click", () => {
    const ids = [...state.sel];
    preview("/api/plan/disk", { ids, unlock: [...state.unlocked].filter((id) => state.sel.has(id)), deleteNow: state.deleteNow }, async () => {
      state.sel.clear();
      const d = await api("/api/disk");
      state.disk = d.scan;
      state.diskFree = d.free;
      render();
    });
  });
}

let pollTimer = null;
async function scanDisk() {
  state.sel.clear();
  state.touched.clear();
  state.unlocked.clear();
  const d = await api("/api/disk/scan", {});
  state.disk = d.scan;
  state.diskFree = d.free;
  render();
  pollScan();
}
function pollScan() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    const d = await api("/api/disk").catch(() => null);
    if (!d) return pollScan();
    state.disk = d.scan;
    state.diskFree = d.free;
    if (d.scan?.done) applyDefaults();
    if (state.view === "disk" && !modal.open) render();
    if (!d.scan?.done) pollScan();
    else updateNav();
  }, 1000);
}

// ---------- Startup ----------
function renderStartup() {
  const s = state.startup;
  if (!s) return `<div class="view"><div class="view-head"><div><h1>Startup</h1><p>Reading what starts with your Mac…</p></div></div><span class="spinner"></span></div>`;
  const agentRow = (i) => {
    const pills = [i.disabled ? pill("Off", "") : i.running ? pill("Running", "ok") : i.loaded ? pill("Ready", "info") : pill("On", "info")];
    if (i.blockedInSettings) pills.push(pill("Blocked in System Settings", "warn"));
    if (i.programMissing) pills.push(pill("Its app was removed", "warn"));
    const btn = i.canToggle ? `<button class="btn small" data-agent="${esc(i.label)}" data-act="${i.disabled ? "turnOn" : "turnOff"}">${i.disabled ? "Turn on" : "Turn off"}</button>` : `<button class="btn small" data-cmds="${esc(i.id)}">${i.disabled ? "How to turn on" : "How to turn off"}</button>`;
    return `<div class="row nocheck"><div><div class="title">${esc(i.name)} <span class="tags">${pills.join("")}</span></div>
      <div class="sub">Runs ${esc(i.when)}${i.developer ? ` · ${esc(i.developer)}` : ""} · ${esc(i.program || "no program listed")}</div>
      ${tech(`label: ${i.label}\nfile: ${i.file}\nruns: ${i.commandLine}`)}</div><div class="right">${btn}</div></div>`;
  };
  return `<div class="view">
    ${state.practice ? `<div class="practice-banner">Practice mode is on. Turn off / Turn on show what they would do and change nothing.</div>` : ""}
    <div class="view-head"><div><h1>Startup</h1><p>Programs that start when you log in or run in the background.</p></div><button class="btn" id="startup-refresh">Refresh</button></div>
    ${s.undo.length ? `<div class="section"><div class="section-head"><div><h2>Recent changes</h2><p>Changes made here. Undo puts an item back the way it was.</p></div></div><div class="rows">${s.undo.map((u) => `<div class="row nocheck"><div><div class="title">${u.action === "turnOff" ? "Turned off" : "Turned on"} ${esc(u.name)}</div><div class="sub">${new Date(u.at).toLocaleString()}</div></div><div class="right"><button class="btn small" data-undo="${u.id}">Undo</button></div></div>`).join("")}</div></div>` : ""}
    <div class="section"><div class="section-head"><div><h2>Login and background items</h2><p>What System Settings lists. macOS only lets you switch these in System Settings.</p></div><button class="btn" id="open-login-items">Open Login Items settings</button></div>
      ${s.loginItemsAvailable ? `<div class="rows">${s.loginItems.map((l) => `<div class="row nocheck"><div><div class="title">${esc(l.name)} <span class="tags">${pill(l.on ? "On" : "Off", l.on ? "ok" : "")}${pill(l.type)}</span></div>${l.developer ? `<div class="sub">${esc(l.developer)}</div>` : ""}${tech(`${l.identifier}\n${l.path}`)}</div><div class="right"></div></div>`).join("")}</div>` : `<div class="empty">Couldn't read the list (sfltool dumpbtm failed).</div>`}
    </div>
    ${s.groups
      .map(
        (g) => `<div class="section"><div class="section-head"><div><h2>${esc(g.title)}</h2><p>${g.scope === "user" ? "Yours to turn off and on here, with undo." : g.scope === "system" ? "Run for the whole Mac. Changing them needs admin rights, so you get the command to run yourself." : "Installed for every user. You get the command to run yourself."} <span class="mono">${esc(g.folder)}</span></p></div></div>
      ${g.items.length ? `<div class="rows">${g.items.map(agentRow).join("")}</div>` : `<div class="empty">None.</div>`}</div>`
      )
      .join("")}
  </div>`;
}

function bindStartup() {
  $("#startup-refresh")?.addEventListener("click", () => load("startup", true));
  $("#open-login-items")?.addEventListener("click", () => preview("/api/plan/startup", { action: "openSettings" }));
  const after = () => load("startup", true);
  main.querySelectorAll("[data-agent]").forEach((b) => b.addEventListener("click", () => preview("/api/plan/startup", { action: b.dataset.act, label: b.dataset.agent }, after)));
  main.querySelectorAll("[data-undo]").forEach((b) => b.addEventListener("click", () => preview("/api/plan/startup", { action: "undo", undoId: b.dataset.undo }, after)));
  main.querySelectorAll("[data-cmds]").forEach((b) =>
    b.addEventListener("click", () => {
      const item = state.startup.groups.flatMap((g) => g.items).find((i) => i.id === b.dataset.cmds);
      showCommands(`${item.disabled ? "Turn on" : "Turn off"} ${item.name}`, item.scope === "system" ? "This needs admin rights. Run these in Terminal; macOS asks for your password." : "Run these in Terminal.", item.adminCommands);
    })
  );
}

// ---------- shell ----------
function updateNav() {
  if (state.ram) $("#nav-ram").textContent = `${size(state.ram.overview.swapUsed)} in swap`;
  if (state.disk?.done) {
    const sel = allItems().filter((i) => state.sel.has(i.id) && i.action !== "pnpm-prune").reduce((s, i) => s + (i.size || 0), 0);
    $("#nav-disk").textContent = `${size(sel)} selected`;
  }
  if (state.startup) $("#nav-startup").textContent = `${state.startup.groups.reduce((s, g) => s + g.items.length, 0)} launch items`;
}

function render() {
  document.querySelectorAll(".nav").forEach((b) => b.classList.toggle("active", b.dataset.view === state.view));
  const scroll = main.scrollTop;
  const detailScroll = $(".detail")?.scrollTop;
  // Keep expanded sections expanded across re-renders.
  const openDetails = new Set([...main.querySelectorAll("details[open] > summary")].map((s) => s.closest(".row, .section, .card")?.textContent.slice(0, 80) + "|" + s.textContent));
  main.innerHTML = state.view === "ram" ? renderRam() : state.view === "startup" ? renderStartup() : renderDisk();
  if (state.view === "ram") bindRam();
  else if (state.view === "startup") bindStartup();
  else bindDisk();
  main.querySelectorAll("details > summary").forEach((s) => {
    if (openDetails.has(s.closest(".row, .section, .card")?.textContent.slice(0, 80) + "|" + s.textContent)) s.parentElement.open = true;
  });
  main.scrollTop = scroll;
  if (detailScroll && $(".detail")) $(".detail").scrollTop = detailScroll;
  updateNav();
}

async function load(view, force = false) {
  try {
    if (view === "ram" && (force || !state.ram)) {
      state.ram = await api("/api/ram");
      // Forget selections for things that went away.
      for (const [k, set] of Object.entries(state.ramSel)) {
        const ids = new Set(k === "simulators" ? state.ram.simulators.devices.map((d) => d.udid) : k === "debuggers" ? state.ram.debuggers.map((d) => String(d.pid)) : k === "devServers" ? state.ram.devServers.map((d) => String(d.pid)) : state.ram.apps.map((a) => a.key));
        for (const id of set) if (!ids.has(id)) set.delete(id);
      }
    }
    if (view === "disk" && !state.disk) {
      const d = await api("/api/disk");
      if (d.scan) {
        state.disk = d.scan;
        state.diskFree = d.free;
        if (d.scan.done) applyDefaults();
        else pollScan();
      } else return scanDisk();
    }
    if (view === "startup" && (force || !state.startup)) state.startup = await api("/api/startup");
  } catch (e) {
    toast(e.message);
  }
  if (state.view === view) render();
  else updateNav();
}

render();
load(state.view);
// Warm the other sections in the background so the sidebar shows numbers.
["ram", "disk", "startup"].filter((v) => v !== state.view).forEach((v) => load(v));

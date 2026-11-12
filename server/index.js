// Local web server. Listens on 127.0.0.1 only and refuses requests from other sites.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ramReport, planRam } from "./ram.js";
import { startScan, publicScan, planDisk, diskFree } from "./disk.js";
import { startupReport, planStartup } from "./startup.js";
import { executePlan, DRY_RUN_FORCED } from "./plans.js";
import { run } from "./util.js";

const HOST = "127.0.0.1";
const PORT = parseInt(process.env.PORT || "4477", 10);
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
// A fresh secret per run. Only the page this server serves knows it, so other sites can't send actions.
const TOKEN = crypto.randomBytes(24).toString("hex");
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error("Request too large");
  }
  return data ? JSON.parse(data) : {};
}

const routes = {
  "GET /api/ram": () => ramReport(),
  "GET /api/disk": async () => ({ scan: publicScan(), free: await diskFree() }),
  "POST /api/disk/scan": async () => ({ scan: startScan(), free: await diskFree() }),
  "GET /api/startup": () => startupReport(),
  "POST /api/plan/ram": (b) => planRam(b.kind, b.ids || []),
  "POST /api/plan/disk": (b) => planDisk(b.ids || [], { unlock: b.unlock || [], deleteNow: !!b.deleteNow }),
  "POST /api/plan/startup": (b) => planStartup(b.action, b),
  "POST /api/execute": (b) => executePlan(b.planId, { dryRun: !!b.dryRun }),
  "POST /api/reveal": async (b) => {
    // Show a scanned item in Finder. Only paths under the home folder.
    const p = String(b.path || "").replace(/^~(?=\/)/, process.env.HOME);
    if (!p.startsWith(process.env.HOME + "/")) throw new Error("Not allowed");
    await run("/usr/bin/open", ["-R", p]);
    return { ok: true };
  },
};

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || "")) return send(res, 403, { error: "Wrong host" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      if (req.headers["x-token"] !== TOKEN) return send(res, 403, { error: "Reload the page." });
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: "Not found" });
      const body = req.method === "POST" ? await readBody(req) : {};
      try {
        return send(res, 200, await handler(body));
      } catch (e) {
        return send(res, 400, { error: String(e.message || e) });
      }
    }
    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC + path.sep)) return send(res, 404, "Not found", "text/plain");
    let content = await fs.readFile(full).catch(() => null);
    if (!content) return send(res, 404, "Not found", "text/plain");
    if (file === "/index.html") content = content.toString().replace("__TOKEN__", TOKEN).replace("__DRY__", DRY_RUN_FORCED ? "1" : "0");
    send(res, 200, content, TYPES[path.extname(full)] || "application/octet-stream");
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`\n  Mac Cleaner Pro is running at ${url}\n  ${DRY_RUN_FORCED ? "Practice mode: no action changes anything.\n  " : ""}Press Control-C to stop.\n`);
  if (process.env.NO_OPEN !== "1") run("/usr/bin/open", [url]);
});
server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is busy. Try: PORT=4478 npm start` : e);
  process.exit(1);
});

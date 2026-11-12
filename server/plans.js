// Every change goes through a plan: the page asks for a preview, shows exactly
// these steps, and only runs them when the person confirms that same plan id.
// A confirmed plan runs as a job; the page polls it to show live progress.
import { newId } from "./util.js";

const PLAN_TTL = 15 * 60 * 1000;
const plans = new Map();
const jobs = new Map();

export const DRY_RUN_FORCED = process.env.DRY_RUN === "1";

/**
 * step = { label, command, bytes?, run: async () => ({ ok, message }) }
 * adminCommands = commands that need admin rights: shown, never run.
 */
export function makePlan({ title, summary, steps = [], warnings = [], adminCommands = [], undoable = false, reclaimBytes = null, afterRun = null }) {
  const plan = { id: newId("p_"), title, summary, steps, warnings, adminCommands, undoable, reclaimBytes, afterRun, createdAt: Date.now(), used: false };
  plans.set(plan.id, plan);
  for (const [id, p] of plans) if (Date.now() - p.createdAt > PLAN_TTL) plans.delete(id);
  return publicPlan(plan);
}

export function publicPlan(plan) {
  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    warnings: plan.warnings,
    undoable: plan.undoable,
    reclaimBytes: plan.reclaimBytes,
    steps: plan.steps.map((s) => ({ label: s.label, command: s.command, bytes: s.bytes || 0 })),
    adminCommands: plan.adminCommands,
    dryRunForced: DRY_RUN_FORCED,
  };
}

/** Start running a plan. Returns the job right away; poll getJob for progress. */
export function startPlan(id, { dryRun = false } = {}) {
  const plan = plans.get(id);
  if (!plan) return { error: "This preview has expired. Close it and try again." };
  if (plan.used) return { error: "This preview was already used. Make a new one." };
  const dry = dryRun || DRY_RUN_FORCED;
  if (!dry) plan.used = true;
  const job = {
    id: newId("j_"),
    title: plan.title,
    dryRun: dry,
    startedAt: Date.now(),
    finishedAt: null,
    done: false,
    stopRequested: false,
    adminCommands: plan.adminCommands,
    steps: plan.steps.map((s) => ({ label: s.label, command: s.command, bytes: s.bytes || 0, status: "pending", message: "", startedAt: null, finishedAt: null })),
  };
  jobs.set(job.id, job);
  for (const [jid, j] of jobs) if (j.done && Date.now() - j.finishedAt > 60 * 60 * 1000) jobs.delete(jid);
  (async () => {
    for (let i = 0; i < plan.steps.length; i++) {
      const view = job.steps[i];
      if (job.stopRequested) {
        view.status = "skipped";
        view.message = "Skipped: you stopped the run.";
        continue;
      }
      view.status = "running";
      view.startedAt = Date.now();
      let r;
      if (dry) r = { ok: true, message: "Practice run: nothing changed." };
      else {
        try {
          r = await plan.steps[i].run();
        } catch (e) {
          r = { ok: false, message: String(e && e.message ? e.message : e) };
        }
      }
      view.status = r.ok ? "done" : "failed";
      view.message = r.message || (r.ok ? "Done" : "Failed");
      view.finishedAt = Date.now();
    }
    if (!dry && plan.afterRun) {
      try {
        await plan.afterRun(job.steps.map((s) => ({ label: s.label, ok: s.status === "done" })));
      } catch {
        /* best effort */
      }
    }
    job.done = true;
    job.finishedAt = Date.now();
  })();
  return publicJob(job);
}

export function getJob(id) {
  const job = jobs.get(id);
  return job ? publicJob(job) : { error: "Unknown job" };
}

export function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return { error: "Unknown job" };
  job.stopRequested = true;
  return publicJob(job);
}

/** The newest job still running, so a reloaded page can pick it up again. */
export function runningJob() {
  const live = [...jobs.values()].filter((j) => !j.done).sort((a, b) => b.startedAt - a.startedAt)[0];
  return live ? publicJob(live) : null;
}

function publicJob(job) {
  const finished = job.steps.filter((s) => s.status !== "pending" && s.status !== "running");
  return {
    id: job.id,
    title: job.title,
    dryRun: job.dryRun,
    done: job.done,
    stopRequested: job.stopRequested,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    now: Date.now(),
    total: job.steps.length,
    completed: finished.length,
    failed: job.steps.filter((s) => s.status === "failed").length,
    bytesTotal: job.steps.reduce((s, x) => s + x.bytes, 0),
    bytesDone: job.steps.filter((s) => s.status === "done").reduce((s, x) => s + x.bytes, 0),
    ok: job.done && job.steps.every((s) => s.status === "done"),
    adminCommands: job.adminCommands,
    steps: job.steps,
  };
}

// Every change goes through a plan: the page asks for a preview, shows exactly
// these steps, and only runs them when the person confirms that same plan id.
import { newId } from "./util.js";

const PLAN_TTL = 15 * 60 * 1000;
const plans = new Map();

export const DRY_RUN_FORCED = process.env.DRY_RUN === "1";

/**
 * step = { label, command, run: async () => ({ ok, message }) }
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
    steps: plan.steps.map((s) => ({ label: s.label, command: s.command })),
    adminCommands: plan.adminCommands,
    dryRunForced: DRY_RUN_FORCED,
  };
}

export async function executePlan(id, { dryRun = false } = {}) {
  const plan = plans.get(id);
  if (!plan) return { ok: false, error: "This preview has expired. Close it and try again." };
  if (plan.used) return { ok: false, error: "This preview was already used. Make a new one." };
  const dry = dryRun || DRY_RUN_FORCED;
  const results = [];
  if (!dry) plan.used = true;
  for (const step of plan.steps) {
    if (dry) {
      results.push({ label: step.label, command: step.command, ok: true, dryRun: true, message: "Practice run: nothing changed." });
      continue;
    }
    let r;
    try {
      r = await step.run();
    } catch (e) {
      r = { ok: false, message: String(e && e.message ? e.message : e) };
    }
    results.push({ label: step.label, command: step.command, ok: !!r.ok, message: r.message || (r.ok ? "Done" : "Failed") });
  }
  if (!dry && plan.afterRun) {
    try {
      await plan.afterRun(results);
    } catch {
      /* best effort */
    }
  }
  return { ok: results.every((r) => r.ok), dryRun: dry, results, adminCommands: plan.adminCommands };
}

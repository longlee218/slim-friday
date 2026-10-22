import { PLAN_MAX_ITEMS, PLAN_MAX_REVISIONS } from "../../config/lead-caps";
import {
  budgetSpentMessage,
  isReservedKey,
  type PlanCtx,
  type PlanDoc,
  type PlanError,
  RESERVED_KEY_PATTERN,
} from "./plan-types";

/* Pure plan validator: no db, no clock. The lead retries on the coded errors. */

/** Keys that form a cycle (or wait for each other forever) among the plan's own items; Kahn's algorithm. */
function cyclicKeys(items: PlanDoc["items"]): string[] {
  const own = new Set(items.map((i) => i.key));
  // A dependency outside the plan (an earlier finished item) is already satisfied.
  const left = new Map(items.map((i) => [i.key, new Set(i.dependsOn.filter((d) => own.has(d)))]));
  for (let progressed = true; left.size && progressed; ) {
    progressed = false;
    for (const [k, deps] of left)
      if (deps.size === 0) {
        left.delete(k);
        for (const d of left.values()) d.delete(k);
        progressed = true;
      }
  }
  return [...left.keys()];
}

/** Check a plan. Returns every error found (empty = valid). */
export function validatePlan(doc: PlanDoc, ctx: PlanCtx): PlanError[] {
  const errs: PlanError[] = [];
  const add = (code: PlanError["code"], message: string, key?: string) =>
    errs.push({ code, message, ...(key && { key }) });
  const { items, envelope: env } = doc;
  if (!items.length) add("NO_ITEMS", "A plan needs at least one item.");
  if (items.length > PLAN_MAX_ITEMS)
    add("TOO_MANY_ITEMS", `A plan holds at most ${PLAN_MAX_ITEMS} items (got ${items.length}).`);
  if (items.length > env.bounds.maxItems)
    add("OUTSIDE_ENVELOPE", `${items.length} items exceed bounds.maxItems ${env.bounds.maxItems}.`);
  if (ctx.revisions > PLAN_MAX_REVISIONS)
    add(
      "TOO_MANY_REVISIONS",
      `At most ${PLAN_MAX_REVISIONS} revisions: call Orchestrate create_plan with the goal id and new item keys.`,
    );
  // The budget is computed by code and capped at the goal ceiling; it is only refused when the goal already spent it all
  // (an empty plan has no budget to compare: NO_ITEMS says it).
  if (items.length && env.budgetUsd <= (ctx.spentUsd ?? 0))
    add("BUDGET", budgetSpentMessage(env.budgetUsd, ctx.spentUsd ?? 0));
  for (const l of env.locations)
    if (!ctx.locations.includes(l))
      add("BAD_LOCATION", `Envelope location ${l} is not in this workspace.`);
  const seen = new Set<string>();
  const known = new Set([...items.map((i) => i.key), ...ctx.existingKeys]);
  for (const it of items) {
    if (seen.has(it.key) || ctx.existingKeys.includes(it.key) || isReservedKey(it.key))
      add(
        "DUP_KEY",
        `Key ${it.key} is already used or reserved (${RESERVED_KEY_PATTERN}).`,
        it.key,
      );
    seen.add(it.key);
    if (!ctx.workerRoles.includes(it.role))
      add("UNKNOWN_ROLE", `Role ${it.role} is not a dispatchable worker.`, it.key);
    if (it.location && !ctx.locations.includes(it.location))
      add("BAD_LOCATION", `Location ${it.location} is not in this workspace.`, it.key);
    else if (it.location && !env.locations.includes(it.location))
      add("OUTSIDE_ENVELOPE", `Location ${it.location} is not in the envelope.`, it.key);
    if (!env.riskClasses.includes(it.risk))
      add("OUTSIDE_ENVELOPE", `Risk ${it.risk} is not in the envelope.`, it.key);
    for (const d of it.dependsOn)
      if (!known.has(d)) add("UNKNOWN_DEP", `Dependency ${d} is not a key of this goal.`, it.key);
      else if (ctx.deadKeys?.includes(d))
        add("DEAD_DEP", `Dependency ${d} failed or was cancelled: it never runs.`, it.key);
      else if (ctx.releasedKeys?.includes(d))
        add(
          "RELEASED_DEP",
          `Dependency ${d} reported NEEDS_PLANNING: approving this plan replaces it. Depend on the plan item that replaces ${d}.`,
          it.key,
        );
  }
  for (const k of cyclicKeys(items)) add("CYCLE", `Item ${k} is part of a dependency cycle.`, k);
  return errs;
}

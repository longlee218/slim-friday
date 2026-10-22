import { CHAIN_CAP, DELEGATE_MAX } from "../../config/lead-caps";
import {
  ORCHESTRATE_ACTION_ADD,
  orchestrateRef,
} from "../../mcp/orchestration/tools/OrchestrateTool/action-names";
import type { ItemRow } from "../../storage/owned-item-store";
import type { StructureOwner } from "../../storage/owned-task-store";
import { isReservedKey } from "../plan/plan-types";
import { assertStructureOwner } from "../plan/structure-owner";
import type { PolicyEnv } from "./caps";
import type { ItemDraft } from "./dispatch-policy";

/* Pure policy of `Orchestrate add` and `Orchestrate update`: whether code allows a change to the lead's open goal.
   No db, no clock. The first failing rule wins, in the order below. */

/** Statuses of an item that ended without a result: nothing may wait for it. */
const DEAD = new Set(["failed", "cancelled"]);
/** Statuses an item may still be edited in. */
const NOT_STARTED = new Set(["pending", "ready"]);

/** A refusal: code and message. */
export interface Refusal {
  code: string;
  message: string;
}
const no = (code: string, message: string): Refusal => ({ code, message });

/** What the policy reads: the goal's owner, its items, the chain count, the budget state and the registries. */
export interface GoalView {
  owner: StructureOwner;
  items: readonly ItemRow[];
  chainCount: number;
  overBudget: boolean;
  env: PolicyEnv;
}

/** True when giving item `key` the dependencies `deps` closes a loop (a dependency already waits for `key`). */
function closesLoop(items: readonly ItemRow[], key: string, deps: readonly string[]): boolean {
  const seen = new Set<string>();
  const stack = [...deps];
  while (stack.length) {
    const k = stack.pop() as string;
    if (k === key) return true;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...(items.find((i) => i.itemKey === k)?.dependsOn ?? []));
  }
  return false;
}

/** Dependency keys that must exist in the goal, must not be dead and must not close a loop. */
function checkDeps(f: GoalView, key: string, deps: readonly string[]): Refusal | undefined {
  for (const k of deps) {
    const dep = f.items.find((i) => i.itemKey === k);
    if (!dep || k === key)
      return no(
        "UNKNOWN_DEP",
        `dependsOn names ${k}, which is not another task of this goal: list and use existing keys.`,
      );
    if (DEAD.has(dep.status))
      return no(
        "DEAD_DEPENDENCY",
        `Task ${k} is ${dep.status}: it never runs, nothing can wait for it. Fix: ${orchestrateRef(ORCHESTRATE_ACTION_ADD)} a replacement task and depend on its key.`,
      );
  }
  if (closesLoop(f.items, key, deps))
    return no("CYCLE", "dependsOn would make tasks wait for each other.");
  return undefined;
}

/** The role / location checks shared by add and update. */
function checkWho(env: PolicyEnv, role?: string, location?: string): Refusal | undefined {
  if (role && !env.workerRoles.includes(role))
    return no("NOT_WORKER", `Role ${role} is not a dispatchable worker: use a role from <team>.`);
  if (location && !env.locations.includes(location))
    return no(
      "BAD_LOCATION",
      `Location ${location} is not in this workspace: use a location from <team>, or register one first.`,
    );
  return undefined;
}

/** `Orchestrate add`: the item the lead wants in the goal -> the draft to write, or a refusal. */
export function checkAdd(
  f: GoalView,
  a: Omit<ItemDraft, "status">,
): { ok: true; item: ItemDraft } | ({ ok: false } & Refusal) {
  const fail = (r: Refusal) => ({ ok: false as const, ...r });
  const notOwner = assertStructureOwner(f.owner);
  if (notOwner) return fail(no(notOwner.code, notOwner.message));
  const who = checkWho(f.env, a.role, a.location);
  if (who) return fail(who);
  if (f.items.some((i) => i.itemKey === a.key))
    return fail(
      no("DUPLICATE_KEY", `Key ${a.key} is already used in this goal: pick another key.`),
    );
  if (isReservedKey(a.key))
    return fail(no("RESERVED_KEY", "Keys verify-N and fix-N belong to the app: pick another key."));
  const deps = checkDeps(f, a.key, a.dependsOn);
  if (deps) return fail(deps);
  if (f.items.length + 1 > DELEGATE_MAX)
    return fail(
      no(
        "NEEDS_PLAN",
        `A goal the lead builds holds up to ${DELEGATE_MAX} tasks: a bigger one needs a plan (call Orchestrate create_plan).`,
      ),
    );
  if (f.chainCount + 1 > CHAIN_CAP)
    return fail(
      no(
        "CHAIN_CAP",
        `At most ${CHAIN_CAP} chained starts without an owner message (${f.chainCount} used): ask the owner first.`,
      ),
    );
  if (f.overBudget)
    return fail(
      no(
        "OVER_BUDGET",
        "The goal budget is used up: a new task would not start. Ask the owner what to do (ask_owner).",
      ),
    );
  const waits = a.dependsOn.some(
    (k) => f.items.find((i) => i.itemKey === k)?.status !== "completed",
  );
  return { ok: true, item: { ...a, status: waits ? "pending" : "ready" } };
}

/** What `Orchestrate update` may change. */
export interface UpdateEdit {
  role?: string | undefined;
  dependsOn?: string[] | undefined;
}

/** `Orchestrate update`: may `item` change this way? Returns the status its dependencies leave it in, or a refusal. */
export function checkUpdate(
  f: GoalView,
  item: ItemRow,
  e: UpdateEdit,
): { ok: true; status?: "pending" | "ready" } | ({ ok: false } & Refusal) {
  const fail = (r: Refusal) => ({ ok: false as const, ...r });
  const notOwner = assertStructureOwner(f.owner);
  if (notOwner) return fail(no(notOwner.code, notOwner.message));
  if (!NOT_STARTED.has(item.status))
    return fail(
      no(
        "ITEM_STARTED",
        `Task is ${item.status}: only a task that has not started can change. Steer it while it runs, retry it if held, or cancel it.`,
      ),
    );
  const who = checkWho(f.env, e.role);
  if (who) return fail(who);
  if (!e.dependsOn) return { ok: true };
  const deps = checkDeps(f, item.itemKey ?? "", e.dependsOn);
  if (deps) return fail(deps);
  const waits = e.dependsOn.some(
    (k) => f.items.find((i) => i.itemKey === k)?.status !== "completed",
  );
  return { ok: true, status: waits ? "pending" : "ready" };
}

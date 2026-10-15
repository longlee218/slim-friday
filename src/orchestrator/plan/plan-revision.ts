import type { Database } from "bun:sqlite";
import { childrenOf } from "../../storage/owned-item-store";
import {
  casPlanStatus,
  insertPlanVersion,
  latestPlan,
  type WorkPlanRow,
} from "../../storage/work-plan-store";
import { envelopeGrew } from "./envelope-diff";
import { type Applied, abortRuns } from "./materialize-items";
import {
  buildEnvelope,
  docOfRow,
  type EnvelopeInput,
  type ItemInput,
  rowFieldsOf,
  toPlanItem,
} from "./plan-doc";
import {
  applyApproval,
  deadKeys,
  type Fail,
  fail,
  invalid,
  otherKeys,
  type PlanEnv,
} from "./plan-lifecycle";
import type { DeliveryMode, PlanDoc } from "./plan-types";
import { validatePlan } from "./validate-plan";

/* Plan revision: a new version from add / cancel / modify, compare-and-set on the base version. History is kept. */

/** Item statuses a revision may still change. */
const NOT_STARTED = new Set(["pending", "ready"]);

/** What a revision changes. */
export interface Edit {
  add: ItemInput[];
  /** Full replacement of the acceptance criteria; omit to keep them. */
  acceptanceCriteria?: string[] | undefined;
  cancel: string[];
  modify: {
    key: string;
    brief?: string | undefined;
    location?: string | undefined;
    dependsOn?: string[] | undefined;
    risk?: string | undefined;
  }[];
  envelope?: EnvelopeInput | undefined;
  budgetUsd?: number | undefined;
  deliveryMode?: DeliveryMode | undefined;
}

/** Outcome of a revision. `status` approved = applied now (envelope did not grow); valid = the owner must approve it. */
export interface Revised {
  ok: true;
  planId: string;
  version: number;
  status: "approved" | "valid";
  affected: Applied;
}

/** A new version from edits, checked against `baseVersion` (a stale base is refused). History is kept. */
export function revisePlan(
  db: Database,
  a: { planId: string; baseVersion: number; edit: Edit; reason: string; env: PlanEnv },
): Revised | Fail {
  const base = latestPlan(db, a.planId);
  if (!base) return fail("NO_PLAN", `Plan ${a.planId} not found.`);
  if (base.version !== a.baseVersion)
    return fail(
      "STALE_VERSION",
      `The latest version is ${base.version}, not ${a.baseVersion}: read it again.`,
    );
  if (base.status !== "valid" && base.status !== "approved")
    return fail("BAD_STATE", `Plan v${base.version} is ${base.status}: it cannot be revised.`);
  const baseDoc = docOfRow(base);
  const rows = new Map(childrenOf(db, base.goalId).map((i) => [i.itemKey, i] as const));
  const keys = new Set(baseDoc.items.map((i) => i.key));
  const touched = [...a.edit.cancel, ...a.edit.modify.map((m) => m.key)];
  const unknown = touched.find((k) => !keys.has(k));
  if (unknown) return fail("UNKNOWN_KEY", `Item ${unknown} is not in plan v${base.version}.`);
  const started = a.edit.modify.find(
    (m) => base.status === "approved" && !NOT_STARTED.has(rows.get(m.key)?.status ?? ""),
  );
  if (started)
    return fail(
      "ITEM_STARTED",
      `Item ${started.key} already started: it cannot be modified, cancel it instead.`,
    );
  const items = [
    ...baseDoc.items
      .filter((i) => !a.edit.cancel.includes(i.key))
      .map((i) => {
        const m = a.edit.modify.find((x) => x.key === i.key);
        return m ? toPlanItem({ ...i, ...stripUndefined(m) }) : i;
      }),
    ...a.edit.add.map(toPlanItem),
  ];
  const oldEnv = baseDoc.envelope;
  const doc: PlanDoc = {
    items,
    acceptanceCriteria: a.edit.acceptanceCriteria ?? baseDoc.acceptanceCriteria,
    envelope: buildEnvelope(
      a.edit.envelope ?? oldEnv,
      items,
      a.edit.budgetUsd ?? oldEnv.budgetUsd,
      a.edit.deliveryMode ?? oldEnv.deliveryMode,
    ),
  };
  const errors = validatePlan(doc, {
    ...a.env,
    existingKeys: otherKeys(db, base.goalId, [...keys]),
    deadKeys: deadKeys(db, base.goalId),
    revisions: base.version,
  });
  if (errors.length) return invalid(errors);
  const grew = base.status === "approved" && envelopeGrew(oldEnv, doc.envelope);
  // One transaction: the new version, the supersede and (when it applies now) the approval land together or not at all.
  let out: { row: WorkPlanRow; done?: Applied & { abort: string[] } };
  try {
    out = db.transaction(() => {
      const row = insertPlanVersion(db, {
        id: base.id,
        goalId: base.goalId,
        strategy: base.strategy,
        objective: base.objective,
        reason: a.reason,
        status: "valid",
        ...rowFieldsOf(doc),
      });
      // A version nobody approved is replaced; an approved one stays in force until its successor is approved.
      if (base.status === "valid")
        casPlanStatus(db, base.id, base.version, "valid", "superseded", a.reason);
      if (base.status === "valid" || grew) return { row };
      const done = applyApproval(db, row.id, row.version);
      if (!done.ok) throw new Refused(done); // rolls the insert back
      return { row, done };
    })();
  } catch (e) {
    if (e instanceof Refused) return e.fail;
    throw e;
  }
  const next = out.row;
  if (!out.done) {
    return {
      ok: true,
      planId: next.id,
      version: next.version,
      status: "valid",
      affected: { created: [], modified: [], cancelled: [] },
    };
  }
  abortRuns(out.done.abort);
  return {
    ok: true,
    planId: next.id,
    version: next.version,
    status: "approved",
    affected: {
      created: out.done.created,
      modified: out.done.modified,
      cancelled: out.done.cancelled,
    },
  };
}

/** Thrown inside the revision transaction to roll it back with a coded refusal. */
class Refused extends Error {
  constructor(readonly fail: Fail) {
    super(fail.message);
  }
}

/** Drop `undefined` fields so a partial modify never blanks an item field. */
const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

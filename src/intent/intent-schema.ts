import { z } from "zod";
import type { TaskClass } from "../config/model-routing";
import { hasClassTiers, ROLES } from "../roles/role-registry";
import { IntentEngineError, type IntentResult } from "./intent-types";

/** Longest `reason` kept (log only). */
const REASON_MAX = 200;

/** Shape of the model's JSON. A null / missing `class` and a long `reason` are tolerated (cleaned, not rejected). */
export const intentResultSchema = z.object({
  role: z.string().trim().min(1).max(64),
  scope: z.enum(["active", "new"]),
  class: z.enum(["mechanical", "standard", "design"]).nullish(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z
    .string()
    .nullish()
    .transform((s) => (s ?? "").slice(0, REASON_MAX)),
});

/**
 * Parse the model's text: the first `{ ... }` object in it (a code fence or a stray sentence around it is
 * tolerated), then zod. Anything else throws `IntentEngineError("schema")`.
 */
export function parseIntentText(text: string): IntentResult {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new IntentEngineError("schema", "no JSON object in output");
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new IntentEngineError("schema", "output is not valid JSON");
  }
  const parsed = intentResultSchema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new IntentEngineError("schema", `output does not match the schema: ${why}`);
  }
  const { class: cls, ...rest } = parsed.data;
  return { ...rest, ...(cls && { class: cls }) };
}

/** What code knows that the model does not. */
export interface IntentValidation {
  /** The thread has a task (running, waiting on a gate, or a live clone). */
  hasTask: boolean;
  /** Owner prefix `[design]` etc.: overrides the model's class. */
  ownerClass?: TaskClass;
  /** L2 class hint (design wording): used when nothing else sets a class. */
  classHint?: TaskClass;
}

export type ValidatedIntent =
  | { ok: true; result: IntentResult }
  | { ok: false; reason: "unknown_role" };

/**
 * Checks AFTER the parse, in code: the role must be in the registry (else the owner is asked); `scope` only
 * means something when the thread has a task (else `new`); `class` is kept only for a role with class tiers
 * (owner prefix > model > L2 hint), else dropped.
 */
export function validateIntent(raw: IntentResult, v: IntentValidation): ValidatedIntent {
  const role = Object.hasOwn(ROLES, raw.role) ? ROLES[raw.role] : undefined;
  if (!role) return { ok: false, reason: "unknown_role" };
  const { class: _modelClass, ...rest } = raw;
  const cls = hasClassTiers(role) ? (v.ownerClass ?? raw.class ?? v.classHint) : undefined;
  return {
    ok: true,
    result: { ...rest, scope: v.hasTask ? raw.scope : "new", ...(cls && { class: cls }) },
  };
}

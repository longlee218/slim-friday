import type { Database } from "bun:sqlite";
import { LEAD_DAILY_BUDGET_USD } from "../strategy/caps";
import { goalCaps } from "./effect-port-queries";

/** Fixed owner notice when the lead's daily budget is used up (no model call, no dispatch). */
export const LEAD_BUDGET_NOTICE = `The lead has used its daily budget ($${LEAD_DAILY_BUDGET_USD}). It will answer again tomorrow; /status still works.`;

/** Fixed owner notice when a lead run failed (quota, error): the `[developer]` tag still starts work directly. */
export const LEAD_FAILED_NOTICE =
  "The lead could not answer right now. Try again later, or start work directly with a role tag such as `[developer] ...`.";

/** True when today's lead runs already cost the daily budget. */
export const leadOverBudget = (db: Database, threadId: string, now = Date.now()): boolean =>
  goalCaps(db, threadId, now).leadSpentTodayUsd >= LEAD_DAILY_BUDGET_USD;

import type { Database } from "bun:sqlite";
import { goalCaps } from "../engine/effect-port-queries";
import { LEAD_DAILY_BUDGET_USD } from "../strategy/caps";

/** Fixed owner notice when the lead's daily budget is used up (no model call, no dispatch). */
export const LEAD_BUDGET_NOTICE = `The lead has used its daily budget ($${LEAD_DAILY_BUDGET_USD}). It will answer again tomorrow; /status still works.`;

/** Fixed owner notice when a lead run failed (quota, error). */
export const LEAD_FAILED_NOTICE = "The lead could not answer right now. Try again later.";

/** True when today's lead runs already cost the daily budget. */
export const leadOverBudget = (db: Database, threadId: string, now = Date.now()): boolean =>
  goalCaps(db, threadId, now).leadSpentTodayUsd >= LEAD_DAILY_BUDGET_USD;

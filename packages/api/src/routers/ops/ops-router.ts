import { MAX_WAKES } from "@friday/contracts";
import { authed } from "../../rpc/implementer";
import { botStatusDtos } from "../bot-status-dto";
import { toWakeDto } from "./ops-dto";

/** Longest `spend` range, in days (both ends included). */
const MAX_SPEND_DAYS = 31;
const DAY_MS = 86_400_000;

/** Epoch ms of a `YYYY-MM-DD` day, or undefined when it is not a real calendar day. */
function dayMs(day: string): number | undefined {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day ? undefined : ms;
}

/** Sessions, wakes and spend, read-only. */
export const opsRouter = {
  sessions: authed.ops.sessions.handler(({ context }) => botStatusDtos(context.deps)),
  /** Newest first, at most `MAX_WAKES`; a row never carries its text. */
  wakes: authed.ops.wakes.handler(async ({ input, context }) => {
    const rows = await context.deps.store.wakes.list({
      ...(input.status && { status: input.status }),
      since: input.since,
      limit: MAX_WAKES,
    });
    return rows.map(toWakeDto);
  }),
  /** `from <= to`, both real days, at most 31 days apart (inclusive). */
  spend: authed.ops.spend.handler(async ({ input, context, errors }) => {
    const from = dayMs(input.from);
    const to = dayMs(input.to);
    if (from === undefined || to === undefined || from > to)
      throw errors.BAD_REQUEST({ message: "Invalid day range." });
    if ((to - from) / DAY_MS + 1 > MAX_SPEND_DAYS)
      throw errors.BAD_REQUEST({ message: `Range is longer than ${MAX_SPEND_DAYS} days.` });
    return {
      rows: await context.deps.store.spend.range(input.from, input.to),
      capPerBotPerDayUsd: context.deps.limits().maxSpendPerBotPerDayUsd,
    };
  }),
};

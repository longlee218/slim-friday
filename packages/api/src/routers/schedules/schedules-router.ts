import type { ScheduleResult } from "@friday/core";
import { ORPCError } from "@orpc/server";
import { logApiEvent } from "../../api-log";
import { authed } from "../../rpc/implementer";
import { scheduleDtoFor, scheduleDtosFor, scheduleRunDtosFor } from "./schedule-dto";

/** Every schedule made here is the owner's. */
const OWNER = { kind: "user" } as const;

/** History rows per page of `runs`. */
const RUNS_PAGE = 20;

/** The typed errors a handler may throw (oRPC passes them to each handler). */
interface Errors {
  NOT_FOUND: () => Error;
  CONFLICT: () => Error;
  BAD_REQUEST: (o: { message: string }) => Error;
}

/** The value of a board result, or the typed error for its refusal code. */
function unwrap<T>(r: ScheduleResult<T>, errors: Errors): T {
  if (r.ok) return r;
  if (r.code === "not_found") throw errors.NOT_FOUND();
  if (r.code === "conflict") throw errors.CONFLICT();
  throw errors.BAD_REQUEST({ message: r.error });
}

/** The owner's schedules, over the core `ScheduleBoard` (`hub.schedules`). */
export const schedulesRouter = {
  list: authed.schedules.list.handler(async ({ context }) => {
    const { hub, store } = context.deps;
    return { items: await scheduleDtosFor(store, await hub.schedules.list()) };
  }),
  get: authed.schedules.get.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const s = await hub.schedules.get(input.id);
    if (!s) throw errors.NOT_FOUND();
    return { schedule: await scheduleDtoFor(store, s) };
  }),
  /** Newest first; one extra row tells whether an older page exists. */
  runs: authed.schedules.runs.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    if (!(await hub.schedules.get(input.id))) throw errors.NOT_FOUND();
    const rows = await hub.schedules.runs(input.id, RUNS_PAGE + 1, input.before);
    const page = rows.slice(0, RUNS_PAGE);
    const more = rows.length > RUNS_PAGE;
    return {
      items: await scheduleRunDtosFor(store, page),
      ...(more && { nextBefore: page[page.length - 1]?.firedAt }),
    };
  }),
  /** The board checks the fields, the time zone and the bot's place in the chat. */
  create: authed.schedules.create.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const r = unwrap(await hub.schedules.create(input, OWNER), errors);
    return scheduleDtoFor(store, r.schedule);
  }),
  update: authed.schedules.update.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const { id, ...patch } = input;
    const r = unwrap(await hub.schedules.update(id, patch), errors);
    return scheduleDtoFor(store, r.schedule);
  }),
  setEnabled: authed.schedules.setEnabled.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const r = unwrap(await hub.schedules.update(input.id, { enabled: input.enabled }), errors);
    return scheduleDtoFor(store, r.schedule);
  }),
  /** A failed write after the run started throws; the client gets a short error, the log the detail. */
  runNow: authed.schedules.runNow.handler(async ({ input, context, errors }) => {
    let r: Awaited<ReturnType<typeof context.deps.hub.schedules.runNow>>;
    try {
      r = await context.deps.hub.schedules.runNow(input.id, input.nonce);
    } catch (err) {
      logApiEvent(
        context.deps.log,
        "schedule.run_now_failed",
        { error: String(err), scheduleId: input.id },
        "error",
      );
      throw new ORPCError("INTERNAL_SERVER_ERROR", { message: "Could not start the run." });
    }
    return { wakeId: unwrap(r, errors).wakeId };
  }),
  delete: authed.schedules.delete.handler(async ({ input, context, errors }) => {
    unwrap(await context.deps.hub.schedules.remove(input.id), errors);
    return {};
  }),
};

import type { TicketResult } from "@friday/core";
import { authed } from "../../rpc/implementer";
import { ticketDtoFor, ticketDtosFor, toTimelineDto } from "./ticket-dto";

/** Every handler here acts as the owner. */
const OWNER = { kind: "user" } as const;

/** The typed errors a handler may throw (oRPC passes them to each handler). */
interface Errors {
  NOT_FOUND: () => Error;
  CONFLICT: () => Error;
  BAD_REQUEST: (o: { message: string }) => Error;
}

/** The value of a board result, or the typed error for its refusal code. */
function unwrap<T>(r: TicketResult<T>, errors: Errors): T {
  if (r.ok) return r;
  if (r.code === "not_found") throw errors.NOT_FOUND();
  if (r.code === "conflict") throw errors.CONFLICT();
  throw errors.BAD_REQUEST({ message: r.error });
}

/** The shared ticket board, over the core `TicketBoard` (`hub.tickets`). */
export const ticketsRouter = {
  list: authed.tickets.list.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const r = unwrap(
      await hub.tickets.list({
        ...(input.status && { status: input.status }),
        ...(input.assignee && { assigneeBotId: input.assignee }),
        ...(input.cursor && { cursor: input.cursor }),
      }),
      errors,
    );
    return {
      items: await ticketDtosFor(store, r.tickets),
      ...(r.nextCursor && { nextCursor: r.nextCursor }),
    };
  }),
  get: authed.tickets.get.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const d = unwrap(await hub.tickets.detail(input.ref), errors);
    return {
      ticket: await ticketDtoFor(store, d.ticket),
      timeline: toTimelineDto(d.timeline),
      related: await ticketDtosFor(store, d.related),
    };
  }),
  create: authed.tickets.create.handler(async ({ input, context, errors }) => {
    const r = unwrap(
      await context.deps.hub.tickets.create(OWNER, {
        title: input.title,
        ...(input.description && { description: input.description }),
        ...(input.priority && { priority: input.priority }),
        ...(input.assignee && { assigneeBotId: input.assignee }),
      }),
      errors,
    );
    return ticketDtoFor(context.deps.store, r.ticket);
  }),
  update: authed.tickets.update.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const r = unwrap(
      await hub.tickets.update(OWNER, {
        id: input.ref,
        ...(input.status && { status: input.status }),
        ...(input.assignee && { assigneeBotId: input.assignee }),
        ...(input.priority && { priority: input.priority }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.blockedReason !== undefined && { blockedReason: input.blockedReason }),
        expectedUpdatedAt: input.expectedUpdatedAt,
      }),
      errors,
    );
    return ticketDtoFor(store, r.ticket);
  }),
  /** The owner's comment wakes the assignee of an unfinished ticket (a finished one is never woken). */
  comment: authed.tickets.comment.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const r = unwrap(await hub.tickets.comment(OWNER, { id: input.ref, body: input.text }), errors);
    const ticket = await store.tickets.get(r.comment.ticketId);
    if (ticket?.assigneeBotId) await hub.wakeForTicket(ticket, ticket.assigneeBotId, false, OWNER);
    return r.comment;
  }),
};

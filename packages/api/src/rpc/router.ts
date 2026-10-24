import { approvalsRouter, questionsRouter } from "../routers/cards-router";
import { chatRouter } from "../routers/chat-router";
import { botsRouter } from "../routers/config/bots-router";
import { groupsRouter } from "../routers/config/groups-router";
import { controlRouter } from "../routers/control-router";
import { conversationsRouter } from "../routers/conversations-router";
import { eventsRouter } from "../routers/events-router";
import { opsRouter } from "../routers/ops/ops-router";
import { ticketsRouter } from "../routers/tickets/tickets-router";
import { authed } from "./implementer";
import { type AppRouterInput, type LooseNode, stubHandlers, stubRouter } from "./stub-router";

/** Stubs for every procedure; `config` is a loose view because only two of its leaves are real yet. */
const stubs = stubRouter() as unknown as { config: Record<string, Record<string, unknown>> };

/** The whole API; later plans replace subtrees: `{ ...stubRouter(), conversations: conversationsRouter }`. */
export const appRouter = authed.router({
  ...(stubs as unknown as AppRouterInput),
  // The two reads are real; every other `config.*` procedure stays a stub until plan 5.
  config: {
    ...stubs.config,
    bots: { ...stubs.config.bots, ...botsRouter },
    groups: { ...stubs.config.groups, ...groupsRouter },
  } as unknown as AppRouterInput["config"],
  conversations: conversationsRouter,
  chat: chatRouter,
  approvals: approvalsRouter,
  questions: questionsRouter,
  control: controlRouter,
  events: eventsRouter,
  tickets: ticketsRouter,
  ops: opsRouter,
});

/** Sorted dot paths whose handler is still a stub. */
export function stubbedProcedures(router: unknown = appRouter): string[] {
  const out: string[] = [];
  const visit = (node: LooseNode, prefix: string) => {
    const handler = (node as { "~orpc"?: { handler?: unknown } })["~orpc"]?.handler;
    if (typeof handler === "function") {
      if (stubHandlers.has(handler)) out.push(prefix);
      return;
    }
    for (const [k, v] of Object.entries(node)) visit(v, prefix ? `${prefix}.${k}` : k);
  };
  visit(router as LooseNode, "");
  return out.sort();
}

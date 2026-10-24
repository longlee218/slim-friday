import { approvalsRouter, questionsRouter } from "../routers/cards-router";
import { chatRouter } from "../routers/chat-router";
import { controlRouter } from "../routers/control-router";
import { conversationsRouter } from "../routers/conversations-router";
import { eventsRouter } from "../routers/events-router";
import { authed } from "./implementer";
import { type LooseNode, stubHandlers, stubRouter } from "./stub-router";

/** The whole API; later plans replace subtrees: `{ ...stubRouter(), conversations: conversationsRouter }`. */
export const appRouter = authed.router({
  ...stubRouter(),
  conversations: conversationsRouter,
  chat: chatRouter,
  approvals: approvalsRouter,
  questions: questionsRouter,
  control: controlRouter,
  events: eventsRouter,
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

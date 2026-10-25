import { approvalsRouter, questionsRouter } from "../routers/cards-router";
import { chatRouter } from "../routers/chat-router";
import { approvalRulesRouter } from "../routers/config/approval-rules-router";
import { avatarsRouter } from "../routers/config/avatars-router";
import { botsRouter } from "../routers/config/bots-router";
import { groupsRouter } from "../routers/config/groups-router";
import { mcpRouter } from "../routers/config/mcp-router";
import { modelsRouter } from "../routers/config/models-router";
import { ownerRouter } from "../routers/config/owner-router";
import { permissionsRouter } from "../routers/config/permissions-router";
import { skillsRouter } from "../routers/config/skills-router";
import { controlRouter } from "../routers/control-router";
import { conversationsRouter } from "../routers/conversations-router";
import { eventsRouter } from "../routers/events-router";
import { memoryRouter } from "../routers/memory-router";
import { opsRouter } from "../routers/ops/ops-router";
import { schedulesRouter } from "../routers/schedules/schedules-router";
import { ticketsRouter } from "../routers/tickets/tickets-router";
import { authed } from "./implementer";
import { type AppRouterInput, type LooseNode, stubHandlers, stubRouter } from "./stub-router";

/** Stubs for every procedure; `config` is a loose view because some of its leaves are still stubs. */
const stubs = stubRouter() as unknown as { config: Record<string, Record<string, unknown>> };

/** The whole API; later plans replace subtrees: `{ ...stubRouter(), conversations: conversationsRouter }`. */
export const appRouter = authed.router({
  ...(stubs as unknown as AppRouterInput),
  // Bots, groups, owner files, MCP, skills and owner rules are real.
  config: {
    ...stubs.config,
    bots: { ...stubs.config.bots, ...botsRouter },
    groups: { ...stubs.config.groups, ...groupsRouter },
    avatars: avatarsRouter,
    owner: ownerRouter,
    mcp: mcpRouter,
    skills: skillsRouter,
    approvalRules: approvalRulesRouter,
    permissions: permissionsRouter,
    models: modelsRouter,
  } as unknown as AppRouterInput["config"],
  conversations: conversationsRouter,
  chat: chatRouter,
  approvals: approvalsRouter,
  questions: questionsRouter,
  control: controlRouter,
  events: eventsRouter,
  memory: memoryRouter,
  tickets: ticketsRouter,
  schedules: schedulesRouter,
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

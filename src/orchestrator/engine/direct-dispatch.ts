import { messageLanguage, renderUserNotice } from "../../ingress/user-copy";
import { dispatchableWorkers } from "../../roles/role-registry";
import { appendEvent } from "../events/event-store";
import { checkDispatch } from "../strategy/dispatch-policy";
import { dispatchReady } from "./dispatch-ready";
import { createDbEffectPort } from "./effect-port-db";
import type { LeadInput } from "./lead-queue";
import type { LeadRuntime, LeadThreadCtx } from "./lead-runtime";

/**
 * The owner's role tag (`[developer] ...`) starts a worker WITHOUT the lead model: the same typed DIRECT dispatch the lead would
 * make (policy, goal, item, work order), so the lead being down never blocks work. Runs inside the lead queue (one input
 * per thread at a time, so it cannot race a lead run). Returns the owner-facing line.
 */
export async function directDispatch(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  d: NonNullable<LeadInput["direct"]>,
): Promise<string> {
  const { db } = rt.deps;
  const { threadId } = ctx.message;
  const language = messageLanguage(ctx.message);
  appendEvent(db, {
    id: `owner:${d.messageId ?? crypto.randomUUID()}`,
    threadId,
    kind: "owner_message",
    payload: { text: d.brief.slice(0, 200), direct: d.role },
  });
  const port = createDbEffectPort({
    db,
    threadId,
    env: {
      workerRoles: dispatchableWorkers().map((r) => r.name),
      locations: ctx.locations.map((l) => l.name),
    },
    io: {
      steerTask: () => "none",
      askOwner: async () => ({ timedOut: true }),
      post: async () => {},
    },
  });
  const supersedes = port.state().openGoalId; // an explicit tag replaces the open goal
  const req = {
    strategy: "DIRECT" as const,
    ...(supersedes && { supersedes }),
    assignments: [
      { key: "main", role: d.role, brief: d.brief, location: d.location, dependsOn: [] },
    ],
  };
  const check = checkDispatch(
    port.state(),
    req,
    { ...port.caps(), dispatchedThisRun: 0 },
    port.env(),
  );
  if (!check.ok) return check.message;
  const w = port.dispatch({
    key: `direct:${crypto.randomUUID()}`,
    strategy: "DIRECT",
    ...(supersedes && { supersedes }),
    intent: d.brief,
    reason: "owner role tag",
    items: check.items,
  });
  if (!w.ok) return w.message;
  await dispatchReady(rt, threadId);
  return renderUserNotice({ kind: "start" }, language);
}

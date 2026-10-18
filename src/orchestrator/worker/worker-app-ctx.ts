import type { OwnerLanguage } from "../../ingress/user-copy";
import { spawnRunner } from "../../locations/git-run";
import { channelDigestBlock } from "../../memory/channel-digest";
import { ownerConfirm } from "../../owner-approval/owner-confirm";
import type { DispatchEnvelope } from "../../policy/envelope";
import { dispatchableWorkers } from "../../roles/role-registry";
import { channelDigest } from "../../storage/thread-store";
import type { LeadRuntime, LeadThreadCtx } from "../lead/lead-runtime";
import { artifactCtx, locationRefs } from "../lead/thread-tool-ctx";
import type { RoleRunInput } from "../run/role-run-types";
import type { ReportSink } from "./report-sink";
import { setProgress, withWaiting } from "./run-activity";

/** What a worker run binds its tools to. */
interface WorkerToolScope {
  threadId: string;
  goalId: string;
  itemId: string;
  turnId: string;
  role: string;
  language: OwnerLanguage;
  envelope: DispatchEnvelope;
  sink: ReportSink;
  /** The run's granted location (a developer may report docs from it). */
  pinned?: { name: string; path: string };
}

/**
 * The ctx parts of a worker's MCP tools; its role's `mcpTools` picks which it gets (a worker has no `lead` part, so
 * it can never hold a lead tool).
 */
export function workerAppCtx(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  s: WorkerToolScope,
): NonNullable<RoleRunInput["appCtx"]> {
  const { db } = rt.deps;
  const { threadId, goalId, itemId } = s;
  return () => ({
    reportSink: s.sink,
    artifacts: artifactCtx(rt, ctx, threadId, s.role, {
      goalId,
      taskId: itemId,
      ...(s.pinned && { granted: { name: s.pinned.name, path: s.pinned.path } }),
    }),
    // ReportProgress: recorded on this task's live run (percent, note, heartbeat).
    progress: (p) => setProgress(db, itemId, p),
    // Plan tools: bound to the goal the planner plans for.
    plan: {
      db,
      threadId,
      goalId,
      workers: dispatchableWorkers(),
      locations: locationRefs(ctx),
      channelDigest: () =>
        ctx.channelId && (ctx.channelMode ?? "task") === "task"
          ? channelDigestBlock(channelDigest(db, ctx.channelId, threadId)).text
          : "",
    },
    // Effect tools: bound to the run's envelope.
    effects: {
      db,
      threadId,
      goalId,
      itemId,
      envelope: s.envelope,
      locations: locationRefs(ctx),
      agentHome: rt.deps.config.agentHome,
      // R4 and over-bound asks go to the owner (fail closed). The run idles meanwhile: the watchdog skips it.
      confirm: (summary) =>
        withWaiting(db, itemId, () =>
          ownerConfirm(rt.deps.approvals, {
            kind: "effect",
            turnId: s.turnId,
            threadId,
            summary,
            language: s.language,
          }),
        ),
      run: spawnRunner,
    },
  });
}

import { type OwnerLanguage, renderUserNotice } from "../../ingress/user-copy";
import { spawnRunner } from "../../locations/git-run";
import { channelDigestBlock } from "../../memory/channel-digest";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { ownerConfirm } from "../../owner-approval/owner-confirm";
import type { DispatchEnvelope } from "../../policy/envelope";
import { dispatchableWorkers } from "../../roles/role-registry";
import { channelDigest } from "../../storage/thread-store";
import { type LeadRuntime, type LeadThreadCtx, postTo } from "../lead/lead-runtime";
import { artifactCtx, locationRefs } from "../lead/thread-tool-ctx";
import { planLinks, planUrlOfGoal, syncPlanArtifacts } from "../plan/plan-artifact";
import { revisionNotice } from "../plan/plan-revised";
import type { RoleRunInput } from "../run/role-run-types";
import type { ReportSink } from "./report-sink";
import { setProgress, withWaiting } from "./run-activity";

/** Logger of this module. */
const log = logger.child({ module: "worker-app-ctx" });

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
  const view = { db, home: rt.deps.config.agentHome, viewer: rt.deps.config.viewer };
  return () => ({
    reportSink: s.sink,
    scratchDir: s.envelope.goalDir,
    artifacts: artifactCtx(rt, ctx, threadId, s.role, {
      goalId,
      taskId: itemId,
      ...(s.pinned && { granted: { name: s.pinned.name, path: s.pinned.path } }),
    }),
    // Report progress: recorded on this task's live run (percent, note, heartbeat).
    progress: (p) => setProgress(db, itemId, p),
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

import { workspacePaths } from "../../config/workspace-paths";
import { messageLanguage } from "../../ingress/user-copy";
import { spawnRunner } from "../../locations/git-run";
import { channelDigestBlock } from "../../memory/channel-digest";
import { logEvent, logger } from "../../observability/logger";
import { ownerConfirm } from "../../owner-approval/owner-confirm";
import { goalLocations, loadEnvelope } from "../../policy/load-envelope";
import { dispatchableWorkers, getRole } from "../../roles/role-registry";
import { recordRunCwd } from "../../storage/effect-log-store";
import {
  bumpDispatch,
  getItem,
  type ItemRow,
  type ResultKind,
} from "../../storage/owned-item-store";
import { getOwnedTask } from "../../storage/owned-task-store";
import { markStartDelivered } from "../../storage/thread-event-store";
import { channelDigest } from "../../storage/thread-store";
import { goalRoute } from "../budget/task-budget";
import type { LeadRuntime, LeadThreadCtx } from "../lead/lead-runtime";
import { afterVerify } from "../plan/goal-verify";
import type { RoleRunInput } from "../run/role-run-types";
import { runTurn } from "../run/run-turn";
import { expectedDelivery } from "../turns/completion";
import { type FailureVerdict, workerFailurePolicy } from "./failure-policy";
import { cancelDependents, settleGoal } from "./goal-settle";
import type { ReportSink } from "./report-sink";
import { startInput } from "./resume-prompt";
import { setProgress, withWaiting } from "./run-activity";
import { earlierSteps, emitEndEvent } from "./worker-end-event";

/** Logger of this module. */
const log = logger.child({ module: "worker-run" });

/**
 * Start one item as a detached worker run: count the dispatch, close its `start` work order, open the turn (the owned
 * task goes `running`) and run with its MCP tools (`ReportResult`...), no subagents, the question relay and a neutral
 * message (a worker never posts to Discord). `after` runs when the run ended: end event, goal settle, next item.
 * Takes its global run slot first: returns false (nothing touched, the item stays ready) when the cap is reached.
 */
export async function startWorker(
  rt: LeadRuntime,
  ctx: LeadThreadCtx,
  threadId: string,
  item: ItemRow,
  after: () => void,
): Promise<boolean> {
  const { db } = rt.deps;
  // The slot is taken before any row changes: a full cap defers the item, it never fails it.
  const slot = rt.deps.limiter ? rt.deps.limiter.tryAcquire() : () => {};
  if (!slot) return false;
  try {
    // The pass read the item before awaiting: a hold (age limit, stop) may have moved it since. Only `ready` starts;
    // a held or ended item is skipped (true = nothing to retry later), only RetryTask can release a hold.
    const current = getItem(db, item.id);
    if (current?.status !== "ready") {
      slot();
      logEvent(log, "dispatch.skipped", { itemId: item.id, status: current?.status }, "warn");
      return true;
    }
    const goalId = item.parentId ?? item.id;
    const role = getRole(getOwnedTask(db, item.id)?.ownerAgentId ?? "");
    // A first start or a lead retry sends the brief (or the resume prompt); an automatic resume is no new dispatch.
    const start = startInput(db, item);
    if (!start.auto) bumpDispatch(db, item.id);
    markStartDelivered(db, item.id);
    const turnId = crypto.randomUUID();
    const location = item.location ?? "*";
    const pinned = ctx.locations.find((l) => l.name === item.location);
    runTurn("worker", rt.deps, {
      begin: {
        log,
        context: { taskId: turnId, workspace: ctx.workspace }, // log schema keys
        ids: {
          turnId,
          threadId,
          source: ctx.message.source,
          single: ctx.locations.length === 1 ? ctx.locations[0]?.name : undefined, // an unpinned task logs under the only location
        },
        turn: { location, brief: item.brief ?? "", role: role.name, hop: 1, ownedTaskId: item.id },
      },
      // Built after the turn row exists (as before): a throw here gives the slot back, the row stays.
      build: () => {
        const sink: ReportSink = {};
        const verdict: { current?: FailureVerdict } = {}; // what the failure policy did, for the end event
        // The envelope is rebuilt from the db at every start (approved plan, dispatch grants or the default): never kept only in memory.
        const language = messageLanguage(ctx.message);
        const envelope = loadEnvelope(
          db,
          goalId,
          // Only the goal's own locations: any other channel location asks the owner at every delete.
          goalLocations(
            db,
            goalId,
            item.location,
            ctx.locations.map((l) => l.name),
          ),
          workspacePaths(rt.deps.config.agentHome).workspace(ctx.workspace).task(turnId).root,
        );
        const input: RoleRunInput = {
          turnId,
          threadId,
          text: start.text,
          ...(start.resume && { resume: start.resume }), // same SDK session, same cwd as its first run
          onCwd: (cwd) => recordRunCwd(db, { turnId, threadId, goalId, itemId: item.id, cwd }),
          language,
          role: role.name,
          workspace: ctx.workspace,
          channel: ctx.channel,
          channelMode: ctx.channelMode,
          channelId: ctx.channelId,
          locations: ctx.locations,
          ac: new AbortController(), // the run's own controller: /stop aborts it, the thread is not held
          pinned,
          ledger: earlierSteps(db, item),
          route: goalRoute(db, goalId), // the run never spends past what the goal has left
          envelope,
          // The ctx parts of this worker's MCP tools; its role's `mcpTools` picks which ones it really gets (a worker has no
          // `lead` part, so it can never hold a lead tool).
          appCtx: () => ({
            reportSink: sink,
            // ReportProgress: recorded on this task's live run (percent, note, heartbeat).
            progress: (p) => setProgress(db, item.id, p),
            // Plan tools: bound to the goal the planner plans for.
            plan: {
              db,
              threadId,
              goalId,
              workers: dispatchableWorkers(),
              locations: ctx.locations.map((l) => ({ name: l.name, path: l.path })),
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
              itemId: item.id,
              envelope,
              locations: ctx.locations.map((l) => ({ name: l.name, path: l.path })),
              agentHome: rt.deps.config.agentHome,
              // R4 and over-bound asks: a yes / no to the owner (fail closed without the button flow).
              // The run idles while the owner decides: the watchdog skips it (never left waiting, even on a throw).
              confirm: (summary) =>
                withWaiting(db, item.id, () =>
                  ownerConfirm(rt.deps.approvals, {
                    kind: "effect",
                    turnId,
                    threadId,
                    summary,
                    language,
                  }),
                ),
              run: spawnRunner,
            },
          }),
          askRelay: role.capabilities.includes("ask")
            ? rt.relay.forWorker({ threadId, goalId, itemId: item.id, turnId })
            : undefined,
        };
        return {
          input,
          detached: {
            language,
            taskId: item.id,
            location,
            delivery: expectedDelivery(db, role, goalId),
            slot,
            resultKind: () => sink.report?.status as ResultKind | undefined, // the schema enum is RESULT_KINDS
            resultTitle: () => sink.report?.title,
            failurePolicy: workerFailurePolicy({
              db,
              itemId: item.id,
              turnId,
              resultKind: () => sink.report?.status as ResultKind | undefined,
              stopping: rt.deps.stopping,
              verdict,
            }),
            onSettled: () => {
              afterVerify(db, item.id, verdict.current, ctx.locations); // fix loop, before the end event
              emitEndEvent(db, threadId, item.id, turnId, sink.report, verdict.current);
              // A held item (blocked) keeps its dependents waiting for the lead; only an item that truly failed
              // (a crash of the run itself, no retry possible) cancels them: they can never start.
              if (getItem(db, item.id)?.status === "failed") cancelDependents(db, item.id);
              settleGoal(db, goalId);
              after();
            },
          },
        };
      },
    });
    return true;
  } catch (err) {
    slot(); // nothing started: give the slot back
    throw err;
  }
}

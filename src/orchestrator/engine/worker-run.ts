import { workspacePaths } from "../../config/workspace-paths";
import { messageLanguage } from "../../ingress/user-copy";
import { spawnRunner } from "../../locations/git-run";
import { channelDigestBlock } from "../../memory/channel-digest";
import { logger } from "../../observability/logger";
import { goalLocations, loadEnvelope } from "../../policy/load-envelope";
import { dispatchableWorkers, getRole } from "../../roles/role-registry";
import {
  bumpDispatch,
  getItem,
  type ItemRow,
  type ResultKind,
} from "../../storage/owned-item-store";
import { getOwnedTask } from "../../storage/owned-task-store";
import { markStartDelivered } from "../../storage/thread-event-store";
import { channelDigest } from "../../storage/thread-store";
import { runTurn } from "../run/run-turn";
import { cancelDependents, settleGoal } from "./goal-settle";
import type { LeadRuntime, LeadThreadCtx } from "./lead-runtime";
import { ownerConfirm } from "./owner-confirm";
import type { ReportSink } from "./report-sink";
import type { RoleRunInput } from "./role-run-types";
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
    const goalId = item.parentId ?? item.id;
    const role = getRole(getOwnedTask(db, item.id)?.ownerAgentId ?? "");
    bumpDispatch(db, item.id);
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
          text: item.brief ?? "",
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
          noSubagents: true, // depth 1: developer too
          envelope,
          // The ctx parts of this worker's MCP tools; its role's `mcpTools` picks which ones it really gets (a worker has no
          // `lead` part, so it can never hold a lead tool).
          appCtx: () => ({
            reportSink: sink,
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
              confirm: (summary) =>
                ownerConfirm(rt.deps.approvals, {
                  kind: "effect",
                  turnId,
                  threadId,
                  summary,
                  language,
                }),
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
            locations: ctx.locations,
            slot,
            resultKind: () => sink.report?.status as ResultKind | undefined, // the schema enum is RESULT_KINDS
            onSettled: () => {
              emitEndEvent(db, threadId, item.id, turnId, sink.report);
              if (getItem(db, item.id)?.status === "failed") cancelDependents(db, item.id); // they can never start
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

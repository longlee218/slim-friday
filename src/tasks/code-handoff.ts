import type { Database } from "bun:sqlite";
import type { Task } from "../ingress/discord-message-handler";
import { excerpt, logEvent, logger, setLogContext, tryLog } from "../observability/logger";
import { errText } from "../observability/redact";
import { isManagedClone } from "../repos/refresh-repo";
import type { Repo } from "../repos/repo-registry";
import { finishTask, insertTask } from "../storage/run-store";
import type { Proposal } from "../tools/delegate-tool";
import { type CodeFlowDeps, runCodeFlow } from "./code-task-flow";
import { closeTask } from "./task-result";
import { codeTaskBlocker } from "./task-routing";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "code-handoff" });

/** Max chars of the brief shown in the "Starting plan" notice. */
const NOTICE_BRIEF_MAX = 200;

/** Q&A outcomes after which a recorded proposal is still acted on (a result message arrived). */
export const HANDOFF_OUTCOMES: ReadonlySet<string> = new Set([
  "success",
  "max_turns",
  "max_budget",
]);

/**
 * Repo name the blocker should pick from: the proposal's `repo`, else the thread's pinned repo when it is a
 * managed clone (an unmanaged pin falls back to every managed clone), else none.
 */
const repoHint = (agentHome: string, pinned: Repo | undefined, repo?: string): string | undefined =>
  repo ?? (pinned && isManagedClone(pinned.path, agentHome) ? pinned.name : undefined);

/**
 * The `delegate` tool's pre-check: refusal text (cap full, no managed clone, unknown repo), or undefined
 * when a code task may start. Same rule as routing and the handoff (`codeTaskBlocker`).
 */
export function delegateCheck(p: {
  db: Database;
  agentHome: string;
  repos: Repo[];
  pinned?: Repo;
}): (repo?: string) => string | undefined {
  return (repo) => {
    const b = codeTaskBlocker(p.db, p.agentHome, p.repos, repoHint(p.agentHome, p.pinned, repo));
    return "reply" in b ? b.reply : undefined;
  };
}

/** Dependencies of the handoff: the code flow's, plus whether shutdown is aborting runs. */
export interface HandoffDeps extends CodeFlowDeps {
  /** True once shutdown aborted the runs: an aborted task is then `interrupted` (resumable), not cancelled. */
  stopping: () => boolean;
}

/** One handoff: the Q&A run is over, the agent proposed a code task. */
export interface HandoffInput {
  /** The triggering message: thread, row source and the `notify` channel into the thread. */
  task: Task;
  /** Reply of the finished Q&A run (shown before the notice). */
  reply: string;
  proposal: Proposal;
  /** All registered repos. */
  repos: Repo[];
  /** Repo the thread is pinned to, when any. */
  pinned?: Repo;
  /** The thread's abort controller (`stop` aborts the plan stage too). */
  ac: AbortController;
}

/**
 * Start the plan stage of a delegated code task right after the Q&A run: re-check the cap, reserve the slot
 * with the code task row, show the owner what was delegated, run the two-stage flow with `brief` as the
 * prompt. Plan approval is the only owner gate (the plan stage writes to its scratch dir only).
 * Returns the reply for the thread (Q&A text + notice + code result, minus what `notify` already posted).
 */
export async function runHandoff(deps: HandoffDeps, i: HandoffInput): Promise<string> {
  const { db, config } = deps;
  const { proposal } = i;
  // `stop` / shutdown after the Q&A run ended: the plan stage would get an already-aborted signal whose
  // abort listener never fires, so it could still post an approval prompt. Drop the proposal.
  if (i.ac.signal.aborted) {
    logEvent(log, "handoff.dropped", { reason: "aborted" });
    return i.reply;
  }
  const hint = repoHint(config.agentHome, i.pinned, proposal.repo);
  // The cap may have filled while the Q&A run was going: re-check before reserving a slot.
  const blocked = codeTaskBlocker(db, config.agentHome, i.repos, hint);
  if ("reply" in blocked) {
    logEvent(log, blocked.event, { reason: blocked.reason, reply: blocked.reply });
    return `${i.reply}\n\n${blocked.reply}`;
  }
  const taskId = crypto.randomUUID();
  // Repo of the row: the picked one (`*` = the plan chooses among the candidates).
  const repo = hint ? (blocked.candidates[0]?.name ?? "*") : "*";
  insertTask(db, {
    id: taskId,
    threadId: i.task.threadId,
    source: i.task.source,
    repo,
    type: "code",
  });
  setLogContext({ taskId, repo, mode: "plan" });
  logEvent(log, "task.started", { repo, type: "code" });
  logEvent(log, "handoff.started", { repo, brief: excerpt(proposal.brief) });
  const t0 = Date.now();

  const notice = `Starting plan: ${repo === "*" ? "repo chosen by the plan" : repo}, ${excerpt(proposal.brief, NOTICE_BRIEF_MAX)}`;
  const head = `${i.reply}\n\n${notice}`;
  // Post the Q&A answer + notice now (the plan can wait minutes for approval); on failure they join the reply.
  const posted = await i.task.notify?.(head).then(
    () => true,
    (err: unknown) => {
      log.warn({ err: errText(err) }, "handoff notify failed; notice joins the final reply");
      return false;
    },
  );
  const res = await runCodeFlow(deps, {
    taskId,
    threadId: i.task.threadId,
    text: proposal.brief,
    repos: blocked.candidates,
    ac: i.ac,
  }).catch((err: unknown) => {
    // The caller's crash path only knows the Q&A row: close this one so its slot is released.
    tryLog(log, "finishTask failed", () => finishTask(db, taskId, "failed"));
    throw err;
  });
  const reply = closeTask(db, { taskId, threadId: i.task.threadId }, res, {
    stopping: deps.stopping(),
    t0,
    repo,
  });
  return posted ? reply : `${head}\n\n${reply}`;
}

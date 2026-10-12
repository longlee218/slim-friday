import type { IntentDeps } from "../intent/decide-intent";
import { logEvent } from "../observability/logger";
import type { SessionRow } from "../storage/session-store";
import { PROPOSAL_EXPIRED_REPLY, pendingProposalFor } from "./dispatch/proposal-flow";
import { drainQueued } from "./dispatch/queued-tasks";
import { startPendingProposal } from "./dispatch/start-proposal";
import { findRepo } from "./dispatch/task-repo";
import { intentTurn, pinnedRepo } from "./intent-turn";
import type { MessageCommand } from "./message-commands";
import { PLAIN_GO, resolveCommand, routeMessage } from "./message-routing";
import { type RoleRunCtx, runTurn } from "./run-turn";
import type { EffortFloors } from "./thread/effort-floor";
import { STILL_WORKING } from "./thread/intent-replies";
import type { IntentOutcome } from "./thread/route-by-intent";
import { refused } from "./turns/turn-tracker";

/** What the handler hands over once it holds the lock and knows the workspace. */
export interface RouteAndRunInput {
  rc: RoleRunCtx;
  parsed: Exclude<MessageCommand, { kind: "stop" | "memory" }>;
  /** The thread's stored session. */
  stored: SessionRow | null;
  floors: EffortFloors;
  /** Undefined = the intent layer is off (tests): every message goes to the entry role. */
  intent?: IntentDeps;
  hasApprovals: boolean;
  /** A fresh abort controller registered as the thread's active one (the queue after a user `/stop`). */
  renewAc: () => AbortController;
}

/**
 * From a parsed command to a finished turn, then the queued tasks start (whatever the turn did: reply, refusal
 * or crash; a crash is re-thrown after the drain so the handler still reports it). After the owner's `/stop` the
 * queue still runs, on a fresh controller (the thread's `/stop` then aborts that one); a shutdown abort does not.
 */
export async function routeAndRun(c: RouteAndRunInput): Promise<string> {
  const { rc, stored } = c;
  const { steer, stopping } = rc.deps;
  const thread = rc.message.threadId;
  const q = { ...rc, pinned: pinnedRepo(rc.repos, undefined, stored) };
  /** Notes of steers a finished run never read (the ones of this turn go out BEFORE the queue starts: a held steer must not leak into the next task). */
  const notes: string[] = [];
  const unread = () => {
    const n = steer?.undeliveredNotice(thread);
    if (n) notes.push(n);
  };
  const next = () => {
    if (rc.ac.signal.aborted && !stopping()) q.ac = c.renewAc();
  };
  let reply: string;
  try {
    reply = await routeTurn(c);
    unread();
  } catch (err) {
    unread();
    next();
    // Best effort: a failing queued task must not hide the crash that ended this one.
    await drainQueued(q, "").catch(() => undefined);
    unread();
    // The notes are not lost with the crash: posted into the thread (best effort), then the crash is re-thrown.
    if (notes.length) await rc.message.notify?.(notes.join("\n\n")).catch(() => undefined);
    throw err;
  }
  next();
  const out = await drainQueued(q, reply);
  unread();
  // Steers the run(s) ended without reading are never silent.
  return notes.length ? `${out}\n\n${notes.join("\n\n")}` : out;
}

/**
 * From a parsed command to a finished run: `go` starts the pending proposal; the Resume button becomes a
 * follow-up / plan run / Q&A; a PLAIN message goes through the intent layer (which picks the role and may
 * ask, queue or open a task instead) and then `routeMessage` + `runTurn`.
 */
async function routeTurn(c: RouteAndRunInput): Promise<string> {
  const { rc, parsed, stored } = c;
  const { db, config } = rc.deps;
  const { message, workspace: ws, repos } = rc;
  // `go` starts the thread's pending proposal (it survived a restart), else it resumes like the button.
  const pending = parsed.kind === "go" ? pendingProposalFor(db, message.threadId, ws) : null;
  if (pending === "expired") return PROPOSAL_EXPIRED_REPLY;
  if (parsed.kind === "go" && pending) {
    const pinned = repos.find((r) => r.name === stored?.repo);
    return startPendingProposal({ ...rc, pinned }, pending, parsed.extraBudgetUsd);
  }
  let extraBudgetUsd = "extraBudgetUsd" in parsed ? parsed.extraBudgetUsd : undefined;
  const input = parsed.kind === "go" ? { kind: "resume" as const, extraBudgetUsd } : parsed;
  // Resume button becomes a plan run / exec re-run / Q&A from the interrupted task's session (or a refusal).
  const rdeps = { db, agentHome: config.agentHome, workspace: ws, repos };
  let resolved = resolveCommand(rdeps, input, message.threadId);
  // Only an ordinary message goes through the intent layer: a bare `go` that falls back to plain text is still L0
  // (the entry role), and a Resume keeps its own role.
  const plain = parsed.kind === "message";
  // `go` with nothing to start or resume is an ordinary message (e.g. "go" in a thread with nothing pending).
  if (parsed.kind === "go" && "reply" in resolved && PLAIN_GO.has(resolved.reason)) {
    resolved = resolveCommand(
      rdeps,
      { kind: "message", text: message.text.trim() },
      message.threadId,
    );
    extraBudgetUsd = undefined; // the raise belongs to a resume, not a plain message
  }
  if ("reply" in resolved) return refused(rc.log, resolved);
  // The intent layer picks the role of a plain message (a Resume keeps its own role).
  let picked: (IntentOutcome & { kind: "run" }) | undefined;
  // (empty text / unknown `repo:` fall through: `routeMessage` refuses them with its own reply)
  const answerable =
    !!resolved.cmd.text && !(resolved.cmd.repo && !findRepo(repos, resolved.cmd.repo));
  if (c.intent && plain && answerable) {
    const out = await intentTurn({
      ...rc,
      intent: c.intent,
      floors: c.floors,
      stored,
      busy: false,
      cmd: resolved.cmd,
    });
    if (out.kind === "reply") return out.text;
    if (out.kind === "side") return STILL_WORKING; // only a busy thread gets one (see route-by-intent `side`)
    picked = out;
    // A yes to the failed task's question: the same path as `/go` (exec runs again from the approved plan).
    if (out.resume) {
      resolved = resolveCommand(rdeps, { kind: "resume" }, message.threadId);
      if ("reply" in resolved) return refused(rc.log, resolved);
    }
    // An outcome may swap the text to run (declined dev task); its `notice` is put before the reply below.
    else if (out.text) resolved = { ...resolved, cmd: { ...resolved.cmd, text: out.text } };
  }
  const route = routeMessage(
    { db, agentHome: config.agentHome, hasApprovals: c.hasApprovals },
    {
      cmd: resolved.cmd,
      threadId: message.threadId,
      repos,
      existing: resolved.existing ?? stored,
      role: picked?.role,
    },
  );
  if ("reply" in route) {
    logEvent(rc.log, route.event, { reason: route.reason, reply: route.reply });
    return route.reply;
  }
  const reply = await runTurn(rc, {
    route,
    plan: resolved,
    existing: stored,
    extraBudgetUsd,
    intent: picked,
  });
  return picked?.notice ? `${picked.notice}\n\n${reply}` : reply;
}

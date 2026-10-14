import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { workspacePaths } from "../config/workspace-paths";
import { realOrSame } from "../guardrails/paths";
import { renderUserNotice } from "../ingress/user-copy";
import type { Location } from "../locations/location-registry";
import { entryRole, getRole, ROLES } from "../roles/role-registry";
import { deterministicPreflight } from "../routing/preflight/deterministic-preflight";
import { getOwnedTask, ownedTaskOfTurn } from "../storage/owned-task-store";
import { latestTurnSession } from "../storage/run-store";
import type { SessionRow } from "../storage/session-store";
import { resumeGone } from "./dispatch/resume-failed-task";
import { findLocation, type Refusal, refuse, resolveTaskLocation } from "./dispatch/task-location";
import { type MessageCommand, RESUME_PROMPT } from "./message-commands";

/** Which role runs a message and where, decided before anything is created. */
export interface Route {
  /** Location the thread is pinned to (or hinted with `location:`), when any. */
  pinned?: Location;
  /** Role that runs the message: the intent layer's pick; a Resume -> its role; else the entry role. */
  role: string;
  /** Background roles: locations the run may work in (the hinted one, else every location). */
  candidates: Location[];
  /** Name for the turn row: the pinned location's, else "*" (not chosen yet: the run's `location:` marker names it). */
  location: string;
}

/**
 * Decide how a message is run: pinned location, the role (from data, see `Route.role`), candidate locations, or a
 * refusal (unknown location, empty text, no approval flow, too many capped tasks). `p.role` = the intent
 * layer's pick: it replaces the entry role.
 */
export function routeMessage(
  deps: { db: Database; agentHome: string; hasApprovals: boolean },
  p: {
    cmd: Extract<MessageCommand, { kind: "message" }>;
    threadId: string;
    locations: Location[];
    existing: SessionRow | null;
    /** Role the intent layer picked; missing = the entry role. */
    role?: string;
  },
): Route | Refusal {
  const { cmd, locations, existing } = p;
  const hint = cmd.location?.toLowerCase();
  const pinned = hint
    ? findLocation(locations, hint)
    : locations.find((r) => r.name === existing?.location); // thread stays on its pinned location
  // A background role runs when the intent layer picks it, or as the Resume of a task (`cmd.role`).
  const roleName = cmd.role ?? p.role ?? entryRole().name;
  // The shared deterministic checks (location, approvals, empty text, task cap); the first failure is the refusal.
  const { refusal } = deterministicPreflight({
    role: roleName,
    text: cmd.text,
    locationHint: cmd.location,
    locations,
    hasApprovals: deps.hasApprovals,
    db: deps.db,
  });
  if (refusal) return refusal;
  const role = getRole(roleName);
  if (!role.background)
    return { pinned, role: role.name, candidates: [], location: pinned?.name ?? "*" };
  const blocked = resolveTaskLocation(locations, cmd.location);
  if ("reply" in blocked) return blocked;
  return {
    pinned,
    role: role.name,
    candidates: blocked.candidates,
    location: pinned?.name ?? "*",
  };
}

/** `cwd` is a registered location of the workspace (a background session must run in one; an old scratch-dir session has none). */
export const inRegisteredLocation = (
  locations: Location[],
  cwd: string | null | undefined,
): boolean => !!cwd && locations.some((r) => realOrSame(r.path) === realOrSame(cwd));

/** Refusal reasons after which a `go` message is treated as plain text (nothing to start or resume). */
export const PLAIN_GO: ReadonlySet<string> = new Set(["cannot_resume", "stale_resume"]);

/** Prompt of a continued task that did not end by a restart (budget, error, or a run that left nothing delivered): its session goes on from where it stopped. */
export const CONTINUE_PROMPT =
  "Your previous run ended before the task was finished (budget, error, or nothing delivered yet). The checkout may already hold part of the work: check `git status` and the diff first, then continue the task from where you stopped.";

/** A runnable command plus what a Resume adds. */
export interface ResumePlan {
  cmd: Extract<MessageCommand, { kind: "message" }>;
  /** Session to resume instead of the thread's stored one (Resume: the interrupted task's own). */
  existing?: SessionRow;
  /** A background task continued in its own session and cwd (`of` = the task it continues: its spend and ceiling carry over). */
  resume?: { sessionId: string; cwd: string; of: string };
}

/**
 * Make the owner's command runnable. A message passes through; the Resume button (and `/go`) continues the latest
 * task of the thread, using the session that task recorded at init: a background role resumes that session in its cwd
 * (the location; it must still exist); a foreground role resumes as a plain message in the workspace cwd dir or one of its
 * locations. Anything else (no session, cwd not usable, or the thread already moved on) -> a reply.
 */
export function resolveCommand(
  deps: { db: Database; agentHome: string; workspace: string; locations: Location[] },
  cmd: Exclude<MessageCommand, { kind: "stop" | "memory" | "go" }>,
  threadId: string,
): ResumePlan | Refusal {
  if (cmd.kind !== "resume") return { cmd };
  const cannot = refuse(
    "cannot_resume",
    renderUserNotice({ kind: "note", state: "cannot-resume" }, "en"),
  );
  const last = latestTurnSession(deps.db, threadId);
  if (!last) return cannot;
  // A `done` turn whose owned task still waits for the owner (the run delivered nothing) can be continued too.
  const undelivered =
    last.status === "done" &&
    getOwnedTask(deps.db, ownedTaskOfTurn(deps.db, last.id) ?? "")?.status === "waiting_user";
  // Only a task that was cut short (or stopped, or ended on its budget, or failed resumable) can be resumed; a newer finished/failed one means stale.
  if (
    !["interrupted", "cancelled", "failed_resumable"].includes(last.status) &&
    !last.budgetStopped &&
    !undelivered
  )
    return refuse("stale_resume", renderUserNotice({ kind: "note", state: "stale-resume" }, "en"));
  // A budget stop with the same budget would stop again: the owner must raise it.
  if (last.budgetStopped && last.status !== "interrupted" && cmd.extraBudgetUsd === undefined)
    return refuse("budget_stop", renderUserNotice({ kind: "note", state: "budget-stop" }, "en"));
  const failed = last.status === "failed_resumable";
  const role = ROLES[last.role];
  const ws = workspacePaths(deps.agentHome).workspace(deps.workspace);
  // A background session runs in the location: the dir must still be there. Nothing to continue = the task is dropped.
  const { sessionId, cwd } = last;
  // A background session must run in a registered location (an old scratch-dir session has none): nothing to continue.
  const inLocation = inRegisteredLocation(deps.locations, cwd);
  if (!sessionId || !cwd || (role?.background && (!existsSync(cwd) || !inLocation)))
    return failed ? resumeGone(deps.db, threadId) : cannot;
  const existing: SessionRow = {
    thread_id: threadId,
    session_id: sessionId,
    location: last.location,
    cwd,
    status: "active",
    updated_at: Date.now(),
  };
  if (role?.background) {
    return {
      // The role is named: the thread's entry role would run it otherwise.
      cmd: {
        kind: "message",
        role: last.role,
        text: failed || undelivered ? CONTINUE_PROMPT : RESUME_PROMPT,
      },
      existing,
      resume: { sessionId: existing.session_id, cwd: existing.cwd, of: last.id },
    };
  }
  // A plain message only resumes in the workspace cwd dir or one of its locations; else the context would be lost.
  const plainCwd = existing.cwd === ws.cwd || deps.locations.some((r) => r.path === existing.cwd);
  return plainCwd ? { cmd: { kind: "message", text: RESUME_PROMPT }, existing } : cannot;
}

export { runRoute } from "./run-route";

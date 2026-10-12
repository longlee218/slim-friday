import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { excerpt, logEvent } from "../../observability/logger";
import { errText } from "../../observability/redact";
import {
  insertProposal,
  PROPOSAL_TTL_MS,
  type Proposal as ProposalRow,
  pendingProposal,
  setProposalStatus,
} from "../../storage/proposal-store";
import type { DispatchRequest } from "./validate-request";

/**
 * Persist a proposal (`pending`) written by the orchestrator from the intent result and the owner message, so a
 * crash before the plan starts cannot lose it (startup then offers `go`). `fromTurnId` = the source turn, when
 * there is one. Never throws: on a storage error the dispatch still runs, only without the crash safety
 * (returns undefined).
 */
export function persistProposal(
  db: Database,
  log: Logger,
  i: {
    request: DispatchRequest;
    threadId: string;
    workspace: string;
    /** Task whose turn proposed it; omitted for an intent-layer proposal. */
    fromTurnId?: string;
  },
): string | undefined {
  try {
    const id = insertProposal(db, {
      threadId: i.threadId,
      workspace: i.workspace,
      fromTurnId: i.fromTurnId,
      role: i.request.role,
      brief: i.request.brief,
      repo: i.request.repo,
      base: i.request.base,
      class: i.request.cls,
      confidence: i.request.confidence,
      reason: i.request.reason,
      effort: i.request.effort,
    });
    logEvent(log, "proposal.persisted", { proposalId: id, brief: excerpt(i.request.brief) });
    return id;
  } catch (err) {
    log.warn({ err: errText(err) }, "proposal persist failed");
    return undefined;
  }
}

/** Reply when `go` meets a proposal older than the TTL. */
export const PROPOSAL_EXPIRED_REPLY =
  "That proposal expired (older than 24h). Please send the request again.";

/**
 * The pending proposal `go` starts: the thread's newest one, only inside the workspace it was made in.
 * One older than the TTL is marked `expired` here (not only at startup) and `expired` is returned so the
 * caller tells the owner to re-send.
 */
export function pendingProposalFor(
  db: Database,
  threadId: string,
  workspace: string,
  now = Date.now(),
): ProposalRow | "expired" | null {
  const p = pendingProposal(db, threadId);
  if (!p || p.workspace !== workspace) return null;
  if (p.createdAt < now - PROPOSAL_TTL_MS) {
    setProposalStatus(db, p.id, "expired", now);
    return "expired";
  }
  return p;
}

import type { Database } from "bun:sqlite";
import type { Client } from "discord.js";
import { SAFE_MENTIONS } from "../ingress/discord-message-rules";
import { logEvent, logger } from "../observability/logger";
import { errText } from "../observability/redact";
import { expireOldProposals, listPendingProposals, releaseQueued } from "../storage/proposal-store";

/** Text of the notice: a pending proposal survived a restart without being started. */
export const PROPOSAL_NOTICE = "Proposal not started; reply `/go` to start";

/** Text of the notice: a queued task lost the run it waited for (restart). */
export const QUEUED_NOTICE = "Queued task not started; reply `/go` to start";

const log = logger.child({ module: "proposal-notices" });

/** Startup: expire proposals older than 24h (no notice for them). Returns how many expired. */
export function expireStaleProposals(db: Database): number {
  const n = expireOldProposals(db);
  if (n) logEvent(log, "proposal.expired", { count: n });
  return n;
}

/** Startup: queued tasks go back to `pending` (`go` starts them); returns their threads for the notice. */
export function releaseQueuedProposals(db: Database): Set<string> {
  const threads = new Set(releaseQueued(db));
  if (threads.size) logEvent(log, "proposal.queued_released", { threads: threads.size });
  return threads;
}

/**
 * Post the notice once per thread with a pending proposal (call after Discord is ready). A failed post is
 * only logged: the proposal stays pending, `go` still works. Returns the number of notices posted.
 */
export async function postProposalNotices(deps: {
  db: Database;
  getClient: () => Client | undefined;
  /** Threads whose pending proposal was queued before the restart (own notice text). */
  queuedThreads?: Set<string>;
}): Promise<number> {
  let posted = 0;
  const threads = new Set(listPendingProposals(deps.db).map((p) => p.threadId));
  for (const threadId of threads) {
    try {
      const channel = await deps.getClient()?.channels.fetch(threadId);
      if (!channel?.isSendable()) throw new Error("no channel");
      await channel.send({
        content: deps.queuedThreads?.has(threadId) ? QUEUED_NOTICE : PROPOSAL_NOTICE,
        allowedMentions: SAFE_MENTIONS,
      });
      posted++;
      logEvent(log, "proposal.offered", { threadId });
    } catch (err) {
      log.warn({ threadId, err: errText(err) }, "proposal notice failed");
    }
  }
  return posted;
}

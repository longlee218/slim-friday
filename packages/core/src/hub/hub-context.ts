import type { CoreLimits } from "../config-defaults";
import type { Bot } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { WakeRow } from "../domain/wake";
import type { ChainGuard } from "../routing/chain-guard";
import type { RunExec } from "../runs/run-exec";
import type { RunHints } from "../runs/run-hints";
import { type BotHubDeps, errText, type WakeOpts, type WakeOutcome } from "./hub-types";
import { postStored } from "./post-stored";
import type { WakeLog } from "./wake-log";

/** The state and entry points the hub's parts share; `BotHub` builds one and passes it around. */
export interface HubContext {
  deps: BotHubDeps;
  limits: CoreLimits;
  /** Runs executing in this process, by scope key (one active run per scope). */
  runs: Map<string, RunExec>;
  /** Set while the in-process runner shuts down: a run that starts now is aborted at once. */
  closing?: boolean;
  guard: ChainGuard;
  wakeLog: WakeLog;
  /** Tells the workers that runs, steering or cards were written. */
  hints: RunHints;
  /** Caps already announced; cleared when the user writes again in that conversation. */
  noticed: Set<string>;
  /** Check the caps for a stored (recovered) run, give it its scope and hint the workers (late-bound: the parts call each other). */
  admit: (row: WakeRow, bot: Bot, opts?: AdmitOpts) => Promise<WakeOutcome>;
  /** Store one message to one bot as a queued run (blocked when a cap says stop). */
  wake: (
    botId: Bot["id"],
    conversationId: ConversationId,
    sender: WakeRow["sender"],
    text: string,
    hop: number,
    opts?: WakeOpts,
  ) => Promise<WakeOutcome>;
}

/** Options of `admit`. */
export type AdmitOpts = Pick<WakeOpts, "exemptFromHops">;

/** Post a system notice; a notice that cannot be posted is logged, never lost silently. */
export async function tell(
  ctx: HubContext,
  conversationId: ConversationId,
  text: string,
): Promise<void> {
  await postStored(ctx.deps, {
    conversationId,
    author: { kind: "system" },
    text,
    at: ctx.deps.clock.now(),
  }).catch((err) =>
    ctx.deps.log?.error({ error: errText(err), conversationId }, "hub.notice_failed"),
  );
}

/** Post one "Stopped: <reason> limit reached." per conversation until the user writes again. */
export async function notice(
  ctx: HubContext,
  conversationId: ConversationId,
  reason: string,
): Promise<void> {
  const key = `${conversationId}|${reason}`;
  if (ctx.noticed.has(key)) return;
  ctx.noticed.add(key);
  await postStored(ctx.deps, {
    conversationId,
    author: { kind: "system" },
    text: `Stopped: ${reason} limit reached.`,
    at: ctx.deps.clock.now(),
  }).catch((err) => ctx.deps.log?.error({ error: errText(err) }, "hub.notice_failed"));
}

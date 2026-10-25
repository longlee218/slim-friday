import type { CardRow } from "../domain/card";
import type { RuntimeToolCall } from "../domain/tool";
import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { inputHash } from "../permission/input-hash";
import type { ToolDecision } from "../ports/agent-runtime";
import { approvalContinuation, DENIAL_TEXT, toolStillExists } from "./approval-continuation";
import { requeueForCard } from "./run-card-answer";
import { abortRun, type RunExec } from "./run-exec";
import { questionsResume } from "./run-questions";
import { holdOrContinue } from "./run-steering";
import { callTainted, noteAllowed } from "./run-taint";

/**
 * One tool call of a run through the permission gate. The resumed run's approved call takes its one shot first:
 * the hash matches, the shot is taken synchronously (a parallel identical call finds none) and counts only when
 * the guarded `answered -> used` change succeeds; otherwise the call is a normal ask. A park waits in place
 * while background tasks run (the answer is applied without a resume) and parks the run otherwise. One ask per
 * run at a time: `reserve` marks it before its card is stored.
 */
export async function decideInRun(
  ctx: HubContext,
  exec: RunExec,
  call: RuntimeToolCall & { conversationId: string },
): Promise<ToolDecision> {
  const { gate, store } = ctx.deps;
  const { row, bot } = exec;
  let shot: string | undefined;
  // The card of the one shot: only an approval asked while tainted counts as a taint approval.
  let shotCard: CardRow | undefined;
  if (exec.oneShot) {
    const hash = await inputHash(call.tool, call.input);
    const s = exec.oneShot;
    if (s?.hash === hash) {
      delete exec.oneShot;
      if (await store.cards.setStatus(s.cardId, "answered", "used"))
        [shot, shotCard] = [hash, await store.cards.get(s.cardId)];
    }
  }
  let mine = false;
  const d = await gate.decide(
    { tool: call.tool, input: call.input, botId: bot.id, conversationId: call.conversationId },
    bot.name,
    {
      wakeId: row.id,
      scopeKey: row.scopeKey,
      chainId: row.chainId,
      tainted: callTainted(exec, call),
      taint: exec.taint,
      ...(shot && { oneShot: shot }),
      reserve: () => {
        if (exec.asking) return false;
        exec.asking = mine = true;
        return true;
      },
      release: () => {
        if (mine) exec.asking = mine = false;
      },
    },
  );
  if (d.behavior !== "park") {
    if (mine) exec.asking = false;
    if (d.behavior === "allow") noteAllowed(ctx, exec, call, shot ? (shotCard ?? {}) : undefined);
    return d;
  }
  const r = await waitOrPark(ctx, exec, d.cardId);
  exec.asking = false;
  if (r === "parked") return d;
  const approved = r.status !== "withdrawn" && (r.answer === "once" || r.answer === "always");
  if (approved) noteAllowed(ctx, exec, call, r);
  return approved ? { behavior: "allow" } : { behavior: "deny", reason: DENIAL_TEXT };
}

/** Wait on `cardId` with the session open while background tasks run; park at once when none run. */
export function waitOrPark(
  ctx: HubContext,
  exec: RunExec,
  cardId: string,
): Promise<CardRow | "parked"> {
  return new Promise((settle) => {
    exec.waiting = { cardId, settle };
    if (exec.tasks.size === 0) parkNow(exec);
    // An answer that came before the wait was registered is applied now.
    else void applyCardAnswer(ctx, exec, cardId);
  });
}

/** Park on the card the run waits on: settle the waiting call and stop the session (the executor parks the row). */
export function parkNow(exec: RunExec): void {
  const w = exec.waiting;
  if (!w) return;
  delete exec.waiting;
  w.settle("parked");
  abortRun(exec, { kind: "park", cardId: w.cardId });
}

/**
 * Hint "card answered" for a run of this process that waits in place: an answered or withdrawn card settles
 * the waiting call (the card becomes `used` first, so nothing else takes the answer again).
 */
export async function applyCardAnswer(
  ctx: HubContext,
  exec: RunExec,
  cardId: string,
): Promise<void> {
  if (exec.waiting?.cardId !== cardId) return;
  const card = await ctx.deps.store.cards.get(cardId);
  if (!card || card.status === "open" || exec.waiting?.cardId !== cardId) return;
  if (
    card.status === "answered" &&
    !(await ctx.deps.store.cards.setStatus(cardId, "answered", "used"))
  )
    return;
  const w = exec.waiting;
  delete exec.waiting;
  w?.settle(card);
}

/**
 * Park a run on `cardId` (spec "Cards that survive"). The fenced transition to `waiting_input` is the commit
 * point; after it, idempotent follow-ups: attempt closed `parked`, steering rows handed on (a parked run does
 * not hold the scope: unanswered rows go back to held and become a continuation run), and an answer that came
 * while parking requeues the run now. The executor stopped the session before. Crash order: a crash after the
 * transition leaves the attempt `running` (bookkeeping) and rows bound to the parked run until the reconciler;
 * a crash before an answer's requeue is covered by the answered-card sweep (`remindWaitingCards`).
 */
export async function parkRun(
  ctx: HubContext,
  row: WakeRow,
  fence: number,
  cardId: string,
): Promise<boolean> {
  const { store, clock } = ctx.deps;
  const patch = { status: "waiting_input" as const, cardId };
  if (!(await store.wakes.transition(row.id, fence, ["running"], patch))) return false;
  await store.attempts.finish(`${row.id}:${fence}`, "parked", clock.now());
  await store.steering.releaseClaimed(row.id);
  await store.steering.unbind(row.id);
  await holdOrContinue(ctx, row.scopeKey, `${row.id}:${fence}`);
  const card = await store.cards.get(cardId);
  if (card && card.status !== "open") await requeueForCard(ctx, card);
  return true;
}

/** What a run that resumes a parked card starts with: the resume text, and the one shot of an approved call. */
export interface CardResume {
  text: string;
  oneShot?: { hash: string; cardId: string };
}

/**
 * The resume of a claimed run that parked on its card (`row.cardId`); undefined when the run did not park or
 * the card is gone. A card still open means the run was queued too early: `open` is returned and the run parks
 * again. The one shot is given only while the card is `answered` (not yet `used`).
 */
export async function cardResume(
  ctx: HubContext,
  exec: RunExec,
): Promise<CardResume | "open" | undefined> {
  const id = exec.row.cardId;
  const card = id ? await ctx.deps.store.cards.get(id) : undefined;
  if (!card || card.wakeId !== exec.row.id) return undefined;
  if (card.status === "open") return "open";
  if (card.kind === "question") return questionsResume(ctx, card);
  const a = card.approval;
  const exists = !!a && toolStillExists(exec.bot, a.tool);
  const text = approvalContinuation(card, exists);
  const approved =
    card.status === "answered" && (card.answer === "once" || card.answer === "always");
  return approved && a && exists
    ? { text, oneShot: { hash: a.inputHash, cardId: card.id } }
    : { text };
}

/**
 * At claim, before any session opens: a run that already has an open card of its own (the process died after
 * the card was written and before the park was stored) parks at once on that card. No session, no cut counted:
 * the attempt the dead worker left is closed `interrupted`, then the same writes as `parkRun`. True when the run
 * parked (or another worker owns it now), so the caller stops.
 */
export async function parkAtClaim(ctx: HubContext, row: WakeRow, fence: number): Promise<boolean> {
  const { store, clock } = ctx.deps;
  const open = (await store.cards.forWake(row.id)).find((c) => c.status === "open");
  if (!open) return false;
  if (row.claimedFrom === "leased" || row.claimedFrom === "running")
    await store.attempts.finish(`${row.id}:${fence - 1}`, "interrupted", clock.now());
  await parkRun(ctx, row, fence, open.id);
  return true;
}

/**
 * The card a claimed run resumes: `row.cardId`, else (the park was never stored, the owner answered meanwhile)
 * its newest card still `answered`. Undefined when the run has none.
 */
export async function resumeCardId(ctx: HubContext, row: WakeRow): Promise<string | undefined> {
  if (row.cardId) return row.cardId;
  return (await ctx.deps.store.cards.forWake(row.id)).filter((c) => c.status === "answered").at(-1)
    ?.id;
}

import type { SteeringRow } from "../domain/steering";
import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";
import type { InboundTurn, SteerInput } from "../ports/agent-runtime";
import { createRun } from "./run-create";
import type { RunExec } from "./run-exec";
import { isConversational } from "./run-rules";
import { addOwnerTexts } from "./run-taint";

/** Dedupe-key prefix that marks a continuation run. */
export const CONTINUATION_KEY = "cont:";

/** The text of a continuation run (it answers owner messages that came while the bot was busy). */
export const CONTINUATION_PROMPT =
  "Respond to the owner's messages that arrived while you were busy.";

/** The line that frames a steering message for the bot. */
const STEERING_HEADER = "New message from the owner while you work:";

/** Statuses of a run that still takes the rows bound to it (a parked run waits for a card, so it is not one). */
const LIVE = ["queued", "leased", "running"];
/** Statuses after which a run takes no more rows. */
const OPEN = [...LIVE, "waiting_input"];

/** The text and files of steering rows, in order: each row is framed as a new owner message. */
export function formatSteering(rows: SteeringRow[]): SteerInput {
  const files = rows.flatMap((r) => r.attachments ?? []);
  return {
    text: rows.map((r) => `${STEERING_HEADER}\n${r.text}`).join("\n\n"),
    ...(files.length > 0 && { attachments: files }),
  };
}

/** A first turn that also carries the steering rows claimed at the start (same text block, files joined). */
export function withSteering(turn: InboundTurn, rows: SteeringRow[]): InboundTurn {
  if (rows.length === 0) return turn;
  const s = formatSteering(rows);
  const files = [...(turn.attachments ?? []), ...(s.attachments ?? [])];
  return {
    ...turn,
    text: `${turn.text}\n\n${s.text}`,
    ...(files.length > 0 && { attachments: files }),
  };
}

/**
 * Take the steering rows bound to a run (marked claimed at `at`, oldest first). Only a conversational run
 * takes steering into its turn; a ticket or bot run leaves its rows held for `holdOrContinue`.
 */
export async function claimSteering(
  ctx: HubContext,
  row: WakeRow,
  at: number,
): Promise<SteeringRow[]> {
  if (!isConversational(row)) return [];
  return ctx.deps.store.steering.claim(row.id, at);
}

/**
 * Push rows bound to the run into its open turn. Calls are chained so two never claim at once. Delivery is
 * only at a point where the model reads the push inside the same turn: right after a tool result
 * (`needsOpenTool` false) or on a hint while a tool call is in flight (`needsOpenTool` true; a push during
 * plain text generation is untested, so those rows wait for the next tool result or become a continuation
 * run). Pushed rows go to `exec.pushed`; they count as answered only when a later tool result follows
 * (`answerPushed`). A claim that finds the turn over, or a push that throws (e.g. an unreadable file), stays
 * claimed and unanswered: the finish offers it again.
 */
export function deliverSteering(
  ctx: HubContext,
  exec: RunExec,
  needsOpenTool: boolean,
): Promise<void> {
  const can = () =>
    exec.live && !exec.stop && exec.turnOpen && !!exec.session && isConversational(exec.row);
  const push = async () => {
    if (!can() || (needsOpenTool && exec.openTools.size === 0)) return;
    const rows = await claimSteering(ctx, exec.row, ctx.deps.clock.now());
    if (rows.length === 0 || !can()) return;
    // Sites named in these owner messages may be fetched by a tainted run (spec §6.10).
    addOwnerTexts(
      exec,
      rows.map((r) => r.text),
    );
    exec.session?.steer(formatSteering(rows));
    exec.pushed.push(...rows.map((r) => r.id));
  };
  const p = (exec.delivering ?? Promise.resolve()).then(push).catch((err) => {
    ctx.deps.log?.error({ error: errText(err), wakeId: exec.row.id }, "run.steer_failed");
  });
  exec.delivering = p;
  return p;
}

/** A tool result followed the pushes so far: the model has read those rows, so they are deleted. */
export async function answerPushed(ctx: HubContext, exec: RunExec): Promise<void> {
  const ids = exec.pushed.splice(0);
  if (ids.length > 0) await ctx.deps.store.steering.remove(ids);
}

/** The first turn reached its end: the rows it carried are answered and deleted. */
export async function answerFirstTurn(ctx: HubContext, exec: RunExec): Promise<void> {
  const ids = exec.firstRows.splice(0);
  if (ids.length > 0) await ctx.deps.store.steering.remove(ids);
}

/**
 * Create the continuation run for the scope's held rows (of the oldest row's conversation) and bind them to
 * it, unless a queued, leased or running run is in the scope (its finish calls this again) or nothing is
 * held. The dedupe key `cont:<first row id>` makes a retry or a crash between create and bind return the same
 * run. A run of that key that already ended (its rows came back held) gets a new key (`:2`, `:3`...). When a
 * cap blocks the run the rows stay held. Called from `finishRun` and when a run parks.
 */
export async function holdOrContinue(
  ctx: HubContext,
  scopeKey: string,
  endedWakeId?: string,
): Promise<void> {
  const { store } = ctx.deps;
  const held = await store.steering.held(scopeKey);
  const first = held[0];
  if (!first) return;
  if ((await store.wakes.activeInScope(scopeKey)).some((w) => LIVE.includes(w.status))) return;
  const rows = held.filter((r) => r.conversationId === first.conversationId);
  const outcome = await createRun(ctx, {
    botId: scopeKey.split("@")[0] ?? scopeKey,
    conversationId: first.conversationId,
    sender: { kind: "user" },
    text: CONTINUATION_PROMPT,
    hop: 0,
    dedupeKey: `${CONTINUATION_KEY}${endedWakeId ?? first.id}`,
  });
  if (!outcome.ok) {
    ctx.deps.log?.warn(
      { scopeKey, rowId: first.id, reason: outcome.reason },
      "run.continuation_not_created",
    );
    return;
  }
  const run = await store.wakes.get(outcome.wakeId);
  if (!run || !OPEN.includes(run.status)) return;
  const bound = await store.steering.bind(
    rows.map((r) => r.id),
    outcome.wakeId,
  );
  if (bound.length > 0) ctx.hints.steer(outcome.wakeId);
}

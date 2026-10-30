import type { WakeRow } from "../domain/wake";
import { recalledBlock } from "../hub/auto-recall";
import type { HubContext } from "../hub/hub-context";
import { ticketContextFor } from "../hub/ticket-support";
import type { InboundTurn } from "../ports/agent-runtime";
import type { MemoryOwner } from "../ports/memory";
import { replyGuidance } from "./reply-guidance";
import { isAutomatedTurn, runKindOf } from "./run-kind";
import { groupOfScopeKey } from "./run-rules";

/** How a run's turn is built. */
export interface RunTurnOpts {
  /** The run was cut before (`cuts > 0`): the turn carries the "your previous turn was cut" note. */
  cut: boolean;
  /** Text that replaces the row's text (a continuation run, Task 9). */
  continuation?: string;
  /**
   * Resume text of a run that parked on a card (the approval continuation or the question's answer): it replaces
   * the row's text, comes from the system, and the row's files and quote are not sent again.
   */
  resume?: string;
  /** Memory already in the session's system prompt (bot and group memory); recall skips notes it holds. */
  shown?: string;
  /** `<state_changed>` block of a resumed session (`OpenedRunSession.stateChanged`), passed into the turn. */
  stateChanged?: string;
}

/** The name of a bot sender (its id when the bot is gone); other senders are named by kind. */
async function senderName(ctx: HubContext, row: WakeRow): Promise<string> {
  if (row.sender.kind !== "bot") return row.sender.kind;
  return (await ctx.deps.store.bots.get(row.sender.botId))?.name ?? row.sender.botId;
}

/**
 * The turn one run pushes into its session: the message, recent group messages, ticket blocks and recalled
 * notes, then the reply guidance of the run's trigger and the current time in the owner's zone (both in the turn,
 * so the cached system prompt stays the same). A continuation or card resume is marked automated. Bot memory, group memory and group context are in the system prompt (read at every open), so they
 * never pile up in a resumed transcript; a resumed session gets the parts that changed as `opts.stateChanged`. A group or ticket session recalls only the group's notes; recent
 * messages come only from a group conversation (a ticket run answers in the DM, with no group chat).
 */
export async function buildRunTurn(
  ctx: HubContext,
  row: WakeRow,
  opts: RunTurnOpts,
): Promise<InboundTurn> {
  const { store, recall } = ctx.deps;
  const conv = await store.conversations.get(row.conversationId);
  const isGroup = conv?.kind === "group";
  const context = isGroup
    ? await store.messages.recent(row.conversationId, ctx.limits.groupContextMessages)
    : [];
  const text = opts.resume ?? opts.continuation ?? row.text;
  const first = opts.resume === undefined;
  const tickets = await ticketContextFor(store, text);
  // A group or ticket scope recalls its group's notes; a direct scope the bot's own notes.
  const groupId = groupOfScopeKey(row.scopeKey);
  const owners: MemoryOwner[] =
    groupId === undefined ? [{ kind: "bot", botId: row.targetBot }] : [{ kind: "group", groupId }];
  const recalled = await recalledBlock(recall, owners, text, opts.shown ?? "", ctx.limits);
  const guidance = replyGuidance(row, runKindOf(row), await senderName(ctx, row));
  // Friday wrote an automated turn's text (continuation, card resume), so its header names the system, never the owner.
  const automated = isAutomatedTurn(row, !first);
  const bot = await store.bots.get(row.targetBot);
  const computerSlots = bot?.computer
    ? `Computer slots on this machine: ${ctx.deps.computerSlotsText?.() ?? "unknown"}`
    : undefined;
  return {
    conversationId: row.conversationId,
    from: automated ? { kind: "system" } : row.sender,
    text,
    hop: row.hop,
    intent: row.intent,
    ...(row.handoff && { handoff: true }),
    ...(opts.cut && { interrupted: true }),
    context,
    ...(tickets && { tickets }),
    ...(first && row.attachments && { attachments: row.attachments }),
    ...(first && row.quote && { quote: row.quote }),
    ...(recalled && { recalled }),
    ...(guidance && { guidance }),
    ...(automated && { automated: true }),
    ...(computerSlots && { computerSlots }),
    ...(opts.stateChanged && { stateChanged: opts.stateChanged }),
    now: ctx.deps.clock.now(),
    timeZone: ctx.deps.timeZone?.() ?? "UTC",
  };
}

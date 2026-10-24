import type { WakeRow } from "../domain/wake";
import { recalledBlock } from "../hub/auto-recall";
import type { HubContext } from "../hub/hub-context";
import { ticketContextFor } from "../hub/ticket-support";
import type { InboundTurn } from "../ports/agent-runtime";
import type { MemoryOwner } from "../ports/memory";

/** How a run's turn is built. */
export interface RunTurnOpts {
  /** The run was cut before (`cuts > 0`): the turn carries the "your previous turn was cut" note. */
  cut: boolean;
  /** Text that replaces the row's text (a continuation run, Task 9). */
  continuation?: string;
  /** Memory already in the session's system prompt (bot and group memory); recall skips notes it holds. */
  shown?: string;
}

/**
 * The turn one run pushes into its session: the message, recent group messages, ticket blocks and recalled
 * notes. Bot memory, group memory and group context are in the system prompt (read at every open), so they
 * never pile up in a resumed transcript. A group session recalls only the group's notes.
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
  const text = opts.continuation ?? row.text;
  const tickets = await ticketContextFor(store, text);
  // A group scope key holds "@"; a direct scope recalls the bot's own notes.
  const owners: MemoryOwner[] = row.scopeKey.includes("@")
    ? []
    : [{ kind: "bot", botId: row.targetBot }];
  if (conv?.kind === "group") owners.push({ kind: "group", groupId: conv.groupId });
  const recalled = await recalledBlock(recall, owners, text, opts.shown ?? "", ctx.limits);
  return {
    conversationId: row.conversationId,
    from: row.sender,
    text,
    hop: row.hop,
    intent: row.intent,
    ...(row.handoff && { handoff: true }),
    ...(opts.cut && { interrupted: true }),
    context,
    ...(tickets && { tickets }),
    ...(row.attachments && { attachments: row.attachments }),
    ...(row.quote && { quote: row.quote }),
    ...(recalled && { recalled }),
  };
}

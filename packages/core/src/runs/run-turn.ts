import type { WakeRow } from "../domain/wake";
import { recalledBlock } from "../hub/auto-recall";
import { groupContextFor } from "../hub/group-context";
import { groupMemoryFor } from "../hub/group-memory";
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
  /** The bot memory already in the session's system prompt; recall skips notes it holds. */
  shown?: string;
}

/**
 * The turn one run pushes into its session. Context, group memory, group context, ticket blocks and recalled
 * notes are loaded fresh: a run opens its own session, so nothing is remembered from an earlier run. A group
 * session recalls only the group's notes (the bot's rules are in its prompt already).
 */
export async function buildRunTurn(
  ctx: HubContext,
  row: WakeRow,
  opts: RunTurnOpts,
): Promise<InboundTurn> {
  const { store, memory, log, projectRules, recall } = ctx.deps;
  const conv = await store.conversations.get(row.conversationId);
  const isGroup = conv?.kind === "group";
  const context = isGroup
    ? await store.messages.recent(row.conversationId, ctx.limits.groupContextMessages)
    : [];
  const groupMemory = conv
    ? await groupMemoryFor(conv, memory, ctx.limits.groupMemoryPromptChars, log)
    : undefined;
  const group = conv?.kind === "group" ? await store.groups.get(conv.groupId) : undefined;
  const groupContext = conv ? await groupContextFor(conv, group, projectRules) : undefined;
  const text = opts.continuation ?? row.text;
  const tickets = await ticketContextFor(store, text);
  // A group scope key holds "@"; a direct scope recalls the bot's own notes.
  const owners: MemoryOwner[] = row.scopeKey.includes("@")
    ? []
    : [{ kind: "bot", botId: row.targetBot }];
  if (conv?.kind === "group") owners.push({ kind: "group", groupId: conv.groupId });
  const shown = `${opts.shown ?? ""}\n${groupMemory ?? ""}`;
  const recalled = await recalledBlock(recall, owners, text, shown, ctx.limits);
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
    ...(groupContext !== undefined && { groupContext }),
    ...(groupMemory !== undefined && { groupMemory }),
    ...(recalled && { recalled }),
  };
}

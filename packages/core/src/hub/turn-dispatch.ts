import type { Conversation } from "../domain/conversation";
import { GROUP_SESSION_KINDS, type MemoryOwner } from "../ports/memory";
import { recalledBlock } from "./auto-recall";
import { changedGroupContext } from "./group-context";
import { changedGroupMemory, promptMemory } from "./group-memory";
import type { HubContext } from "./hub-context";
import { EMPTY_MEMORY_NOTE } from "./memory-label";
import type { PoolEntry, QueuedWake } from "./session-pool";
import { ticketContextFor } from "./ticket-support";

/** Send one message into the bot's session. */
export async function dispatch(ctx: HubContext, entry: PoolEntry, q: QueuedWake): Promise<void> {
  const { store, surface, clock } = ctx.deps;
  // Claim the bot before the first await: a wake that arrives meanwhile sees it busy and waits.
  entry.current = { conversationId: q.conversationId, hop: q.hop };
  entry.conversations.add(q.conversationId);
  entry.currentWakeId = q.wakeId;
  entry.currentTicket = q.ticketId ? { id: q.ticketId, rewake: q.rewake === true } : undefined;
  entry.turnTexts = [];
  entry.sentResults = new Set();
  entry.busy = true;
  let conv: Conversation | undefined;
  // The memory shown before this turn: a failed send puts it back so the updated memory goes with the next turn.
  const shownBefore = entry.memoryShown;
  let botMemory: string | undefined;
  try {
    conv = await store.conversations.get(q.conversationId);
    const context =
      conv?.kind === "group"
        ? await store.messages.recent(q.conversationId, ctx.limits.groupContextMessages)
        : [];
    botMemory = await botMemoryAfterCompaction(ctx, entry);
    const groupMemory = conv
      ? await changedGroupMemory(
          entry,
          conv,
          ctx.deps.memory,
          ctx.limits.groupMemoryPromptChars,
          ctx.deps.log,
        )
      : undefined;
    const group = conv?.kind === "group" ? await store.groups.get(conv.groupId) : undefined;
    const groupContext = conv
      ? await changedGroupContext(entry, conv, group, ctx.deps.projectRules)
      : undefined;
    const tickets = await ticketContextFor(store, q.text);
    const recalled = await recalledFor(ctx, entry, conv, q.text);
    await ctx.wakeLog.started(q.wakeId);
    entry.lastActive = clock.now();
    surface.showActivity(q.conversationId, { kind: "typing", botId: entry.bot.id });
    entry.session.send({
      conversationId: q.conversationId,
      from: q.sender,
      text: q.text,
      hop: q.hop,
      intent: q.intent,
      ...(q.handoff && { handoff: true }),
      ...(q.interrupted && { interrupted: true }),
      context,
      ...(tickets && { tickets }),
      ...(q.attachments && { attachments: q.attachments }),
      ...(q.quote && { quote: q.quote }),
      ...(groupContext !== undefined && { groupContext }),
      ...(botMemory !== undefined && { botMemory }),
      ...(groupMemory !== undefined && { groupMemory }),
      ...(recalled && { recalled }),
    });
  } catch (err) {
    // A send that fails (for example an unreadable attachment) must not leave the bot busy for good.
    entry.busy = false;
    // Nor mark any memory or context as sent: the next turn carries them again.
    if (botMemory !== undefined) {
      entry.memoryShown = shownBefore;
      entry.memoryStale = true;
    }
    if (conv?.kind === "group") {
      entry.groupMemorySent.delete(conv.groupId);
      entry.groupContextSent.delete(conv.groupId);
    }
    entry.currentWakeId = undefined;
    await ctx.wakeLog.dropped(q.wakeId);
    throw err;
  }
}

/**
 * The bot's memory for the first turn after a compaction, when it changed since the session last saw it (notes saved
 * mid-session may have been summarized away); it becomes the memory shown. Undefined otherwise or on a failed read.
 */
async function botMemoryAfterCompaction(
  ctx: HubContext,
  entry: PoolEntry,
): Promise<string | undefined> {
  if (!entry.memoryStale) return undefined;
  entry.memoryStale = false;
  const owner: MemoryOwner = { kind: "bot", botId: entry.bot.id };
  const text = await promptMemory(
    ctx.deps.memory,
    owner,
    ctx.limits.memoryPromptChars,
    ctx.deps.log,
    entry.groupId ? GROUP_SESSION_KINDS : undefined,
  );
  if (text === entry.memoryShown) return undefined;
  // An empty text is also what a failed read gives: report an emptied memory only when the file really is empty.
  if (!text.trim()) {
    const raw = await ctx.deps.memory?.read(owner).catch(() => undefined);
    if (raw === undefined || raw.trim()) return undefined;
  }
  entry.memoryShown = text;
  // An emptied memory is said so: the summary may still hold notes the owner removed.
  return text.trim() ? text : EMPTY_MEMORY_NOTE;
}

/**
 * Recalled notes for a turn: the bot's in a direct session, the group's on a group turn; memory already shown is
 * skipped. A group session recalls none of the bot's own notes (its rules are in the prompt already).
 */
function recalledFor(
  ctx: HubContext,
  entry: PoolEntry,
  conv: Conversation | undefined,
  text: string,
) {
  const owners: MemoryOwner[] = entry.groupId ? [] : [{ kind: "bot", botId: entry.bot.id }];
  let shown = entry.memoryShown;
  if (conv?.kind === "group") {
    owners.push({ kind: "group", groupId: conv.groupId });
    shown += `\n${entry.groupMemorySent.get(conv.groupId) ?? ""}`;
  }
  return recalledBlock(ctx.deps.recall, owners, text, shown, ctx.limits);
}

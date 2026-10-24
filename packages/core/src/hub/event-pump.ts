import type { Author } from "../domain/message";
import type { Clock } from "../ports/clock";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import type { PoolEntry } from "./session-pool";

/** What the pump needs from the hub. */
export interface PumpHooks {
  /** A bot said something: store and route it (hand-offs). */
  onBotText(entry: PoolEntry, text: string): Promise<void>;
  /** A turn ended: the bot is free for the next queued message. */
  onTurnEnd(entry: PoolEntry): Promise<void>;
  /** The session ended: drop it; `crashed` is false after a deliberate stop. */
  onClosed(entry: PoolEntry, crashed: boolean, reason?: string): Promise<void>;
}

/** UTC calendar day of an epoch time, as YYYY-MM-DD. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Reads one session's events until it ends: bot text goes out, task changes update the status,
 * turn costs go to the spend total, a failure closes the session.
 */
export async function pumpEvents(
  entry: PoolEntry,
  deps: { surface: Surface; store: Store; clock: Clock },
  hooks: PumpHooks,
): Promise<void> {
  const { surface, store, clock } = deps;
  const botAuthor: Author = { kind: "bot", botId: entry.bot.id };
  try {
    for await (const e of entry.session.events) {
      entry.lastActive = clock.now();
      if (e.type === "text") {
        const conversationId = entry.current.conversationId;
        await surface.post(conversationId, { author: botAuthor, text: e.text });
        await store.messages.append({
          conversationId,
          author: botAuthor,
          text: e.text,
          at: clock.now(),
        });
        await hooks.onBotText(entry, e.text);
      } else if (e.type === "task_started") {
        entry.tasks.set(e.taskId, {
          description: e.description,
          conversationId: entry.current.conversationId,
          hop: entry.current.hop,
        });
        surface.showActivity(entry.current.conversationId, {
          kind: "subagent",
          botId: entry.bot.id,
          label: e.description,
        });
      } else if (e.type === "task_done") {
        const task = entry.tasks.get(e.taskId);
        entry.tasks.delete(e.taskId);
        // The result is the bot's next turn; it speaks where the task began.
        if (task) entry.current = { conversationId: task.conversationId, hop: task.hop };
      } else if (e.type === "compacted") {
        // The summary may have dropped the group memory the bot was shown: send it again on the next group turn.
        entry.groupMemorySent.clear();
        entry.groupContextSent.clear();
      } else if (e.type === "turn_end") {
        entry.busy = false;
        await store.spend.add(entry.bot.id, dayOf(clock.now()), e.costUsd);
        await hooks.onTurnEnd(entry);
      } else if (e.type === "error") {
        await hooks.onClosed(entry, true, e.message);
        return;
      }
    }
    await hooks.onClosed(entry, !entry.stopping);
  } catch (err) {
    await hooks.onClosed(entry, true, err instanceof Error ? err.message : String(err));
  }
}

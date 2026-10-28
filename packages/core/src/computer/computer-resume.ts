import type { BotId } from "../domain/bot";

/** The note a bot wakes with after the owner gave the computer back. */
export const RESUME_NOTE = "the owner used the computer; check its state before continuing";

/** Queues one wake for a bot; `key` is unique per give-back, so a repeat never adds a second run. */
export type WakeBot = (botId: BotId, text: string, key: string) => Promise<unknown>;

/** Bots turned away by the owner's control, and the wake that resumes them. */
export interface ComputerResume {
  /** A bot's tool call was refused because the owner controls `computer`. */
  noteBlockedByOwner(botId: BotId, computer: string): void;
  /** The owner gave `computer` back (or the hold lapsed): one wake per recorded bot, then forget them. */
  resumeAfterGiveBack(computer: string): Promise<void>;
}

/** The blocked-bot set lives in memory: a restart forgets it, and the bot asks again on its next turn. */
export function computerResume(wake: WakeBot): ComputerResume {
  const blocked = new Map<string, Set<BotId>>();
  let round = 0;
  return {
    noteBlockedByOwner(botId, computer) {
      const set = blocked.get(computer) ?? new Set<BotId>();
      set.add(botId);
      blocked.set(computer, set);
    },
    async resumeAfterGiveBack(computer) {
      const bots = blocked.get(computer);
      blocked.delete(computer);
      if (!bots) return;
      const key = `computer-resume:${computer}:${++round}`;
      for (const botId of bots)
        await wake(botId, RESUME_NOTE, `${key}:${botId}`).catch(() => undefined);
    },
  };
}

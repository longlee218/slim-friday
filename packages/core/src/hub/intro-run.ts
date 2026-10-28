import type { BotId } from "../domain/bot";
import { createRun } from "../runs/run-create";
import type { HubContext } from "./hub-context";
import { errText } from "./hub-types";

/**
 * The hidden prompt of a new bot's first run (R§2, Friday's tool names). The greeting goes in the question itself:
 * text streamed before `AskUserQuestion` is not kept once the run parks on the card.
 */
export const INTRO_TEXT = [
  "You were just created. The owner made you.",
  "Call AskUserQuestion right away, with no text before it. Its question greets the owner in a few words and asks what they want you for, with two to four short options that fit your name, anything your title, description or instructions already say, and what you know about them, never a stock list. They can also type their own answer.",
  "If your profile already makes that clear, say in one line what you will do instead of asking.",
  "Once you know what you are for, use UpdateProfile to set your title to a short role and your description to one line. Leave them unset if the answer is too vague, and keep your name and look.",
  "Then get started, asking one follow-up only if you cannot start without it.",
].join("\n");

/**
 * Queue one system run for a bot in its direct conversation; `dedupeKey` makes a repeat return the first run.
 * A bot without a direct chat gets none.
 */
export async function queueSystemRun(
  ctx: HubContext,
  botId: BotId,
  text: string,
  dedupeKey: string,
): Promise<void> {
  const conv = await ctx.deps.store.conversations.direct(botId);
  if (!conv) return;
  await createRun(ctx, {
    botId,
    conversationId: conv.id,
    sender: { kind: "system" },
    text,
    hop: 0,
    dedupeKey,
  });
}

/**
 * Queue the intro run of a new bot in its direct conversation: sender system, one per bot (a second call returns
 * the first run, so a repeated create or reload adds none). Never throws: a bot without a direct chat gets none.
 */
export async function queueIntroRun(ctx: HubContext, botId: BotId): Promise<void> {
  try {
    const conv = await ctx.deps.store.conversations.direct(botId);
    if (!conv) return;
    await createRun(ctx, {
      botId,
      conversationId: conv.id,
      sender: { kind: "system" },
      text: INTRO_TEXT,
      hop: 0,
      dedupeKey: `intro:${botId}`,
      opts: { intro: true },
    });
  } catch (err) {
    ctx.deps.log?.error({ error: errText(err), botId }, "hub.intro_failed");
  }
}

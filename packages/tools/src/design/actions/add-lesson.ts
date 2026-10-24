import type { DesignArgs } from "../design-args";
import type { DesignContext } from "../design-context";
import { need, plainId, Refused } from "../design-util";

/** Longest lesson: one short line, like a note in the bot's memory. */
const MAX_LESSON = 300;

/** `add_lesson`: one line under `## Lessons` of an existing bot's MEMORY.md (never the Friday bot's). */
export async function addLesson(ctx: DesignContext, a: DesignArgs): Promise<string> {
  const id = plainId(a.id);
  if (ctx.reservedBotIds.includes(id)) throw new Refused(`bot "${id}" is reserved.`);
  if (!ctx.botSummaries().some((b) => b.id === id))
    throw new Refused(`bot "${id}" does not exist.`);
  const lesson = need(a.lesson, "lesson").trim();
  if (lesson.includes("\n")) throw new Refused("a lesson is one line.");
  if (lesson.length > MAX_LESSON) throw new Refused(`a lesson is at most ${MAX_LESSON} chars.`);
  try {
    await ctx.memory.save({ kind: "bot", botId: id }, lesson, "lesson");
  } catch (err) {
    // The memory refuses an empty, too long or duplicate note with a code: pass it on as a rule.
    const code = (err as { code?: string }).code;
    if (code) throw new Refused(`the memory refused the lesson (${code}).`);
    throw err;
  }
  return `Saved the lesson in ${id}'s memory; its next turn sees it.`;
}

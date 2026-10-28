import type { BotId } from "../domain/bot";
import type { HubContext } from "../hub/hub-context";
import { errText } from "../hub/hub-types";

/**
 * Free the computer a run held (its slot and the bot's browser), once the run reached an end in this process. The
 * hook acts only for the slot this wake holds, so another run of the same bot keeps its own. A failure is logged,
 * never thrown (the slot's TTL frees it anyway).
 */
export async function releaseComputer(
  ctx: HubContext,
  botId: BotId,
  wakeId: string,
): Promise<void> {
  const release = ctx.deps.computerRelease;
  if (!release) return;
  try {
    await release(botId, wakeId);
  } catch (err) {
    ctx.deps.log?.warn(
      { event: "computer.release_failed", botId, wakeId, err: errText(err) },
      "computer.release_failed",
    );
  }
}

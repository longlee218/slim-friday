import type { BotId } from "../domain/bot";
import type { ConversationId } from "../domain/conversation";
import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { isConversational } from "./run-rules";

/** Dedupe key of the run an owner message starts for one bot; it also names the message (see `messageIdOf`). */
export function ownerRunKey(messageId: number, botId: BotId): string {
  return `owner:${messageId}:${botId}`;
}

/** Id of the steering row of owner message `messageId` for one bot: one row per message and bot. */
export function steeringId(messageId: number, botId: BotId): string {
  return `steer:${messageId}:${botId}`;
}

/** The stored message id an owner run was started by, read back from its dedupe key. */
function messageIdOf(w: WakeRow): number | undefined {
  const m = /^owner:(\d+):/.exec(w.dedupeKey ?? "");
  return m ? Number(m[1]) : undefined;
}

/** Is `a` stored before `b` (createdAt, then id: ids of one process sort in creation order)? */
const before = (a: WakeRow, b: WakeRow) =>
  a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);

/**
 * A new owner run cancels the older owner runs of its scope and conversation that are still `queued` and
 * were never claimed (Rakazo `cancelSupersededQueuedRuns`), and moves their texts, and any steering bound to
 * them, into steering rows bound to the new run, so nothing the owner wrote is lost. Runs of another
 * conversation are left alone, so each answer goes where it was asked. In practice this settles two owner
 * messages that raced for a free scope (both saw it free and both stored a run).
 *
 * Order per old run: copy first (deterministic ids, so a replay adds nothing twice), then cancel it (guarded on
 * `queued` and fence 0); a cancel that fails (a worker claimed it) deletes the copies, a cancel that succeeds
 * deletes the originals. A crash between copy and cancel leaves a duplicate, never a loss.
 */
export async function supersede(
  ctx: HubContext,
  scopeKey: string,
  conversationId: ConversationId,
  newWakeId: string,
): Promise<void> {
  const { store, clock } = ctx.deps;
  const active = await store.wakes.activeInScope(scopeKey);
  const fresh = active.find((w) => w.id === newWakeId);
  if (!fresh) return;
  const cancelled: string[] = [];
  for (const old of active) {
    const messageId = messageIdOf(old);
    const stale =
      old.id !== newWakeId &&
      old.status === "queued" &&
      old.leaseFence === 0 &&
      old.startedAt === undefined &&
      old.conversationId === conversationId &&
      isConversational(old) &&
      messageId !== undefined &&
      before(old, fresh);
    if (!stale || messageId === undefined) continue;
    const originals = await store.steering.bound(old.id);
    const copies = [
      {
        id: steeringId(messageId, old.targetBot),
        messageId,
        conversationId,
        scopeKey,
        text: old.text,
        ...(old.attachments && { attachments: old.attachments }),
        createdAt: old.createdAt,
      },
      ...originals.map((r) => ({ ...r, id: `${r.id}>${newWakeId}` })),
    ];
    for (const c of copies) await store.steering.add({ ...c, wakeId: newWakeId });
    const ended = { status: "cancelled" as const, endedAt: clock.now() };
    if (await store.wakes.transition(old.id, 0, ["queued"], ended)) {
      cancelled.push(old.id);
      await store.steering.remove(originals.map((r) => r.id));
    } else await store.steering.remove(copies.map((c) => c.id));
  }
  if (!cancelled.length) return;
  ctx.hints.cancel(cancelled);
  ctx.hints.steer(newWakeId);
}

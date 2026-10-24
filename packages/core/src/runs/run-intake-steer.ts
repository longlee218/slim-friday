import type { Attachment } from "../domain/message";
import type { WakeRow } from "../domain/wake";
import type { HubContext } from "../hub/hub-context";
import { isConversational } from "./run-rules";

/** Statuses of a run that will still claim the steering bound to it. */
const LIVE = ["queued", "leased", "running"];

/** One owner message to steer into a busy scope. */
export interface SteerInput {
  /** Deterministic row id (`steer:<messageId>:<botId>`). */
  id: string;
  /** Stored id of the owner message. */
  messageId: number;
  /** Conversation the message was sent in. */
  conversationId: string;
  /** Scope of the addressed bot. */
  scopeKey: string;
  /** Text the row carries. */
  text: string;
  /** Files sent with the message. */
  attachments?: Attachment[];
}

/**
 * Add a steering row for a busy scope. `busy` are the scope's queued/leased/running runs of this conversation.
 * The row is bound to the owner run (the leased/running one first, else the newest queued one), or held when
 * only bot or ticket runs are busy. Then the host (or, for a held row, the scope) is read again: if it ended in
 * the meantime nobody would ever claim the row, so the row is removed and false is returned (the caller starts
 * a run instead). A row already claimed was delivered and stays. True: the row will be delivered.
 */
export async function steerIntoBusyScope(
  ctx: HubContext,
  s: SteerInput,
  busy: WakeRow[],
): Promise<boolean> {
  const { store, clock } = ctx.deps;
  const owners = busy.filter(isConversational);
  const host = owners.find((w) => w.status !== "queued") ?? owners.at(-1);
  await store.steering.add({ ...s, ...(host && { wakeId: host.id }), createdAt: clock.now() });
  if (host) {
    const now = await store.wakes.get(host.id);
    if (now && LIVE.includes(now.status)) {
      ctx.hints.steer(host.id);
      return true;
    }
    return !(await removeIfUnclaimed(ctx, s.id, await store.steering.bound(host.id)));
  }
  const stillBusy = (await store.wakes.activeInScope(s.scopeKey)).some(
    (w) => LIVE.includes(w.status) && w.conversationId === s.conversationId,
  );
  if (stillBusy) return true;
  return !(await removeIfUnclaimed(ctx, s.id, await store.steering.held(s.scopeKey)));
}

/** Remove row `id` when it is among `unclaimed`; true when it was removed. */
async function removeIfUnclaimed(
  ctx: HubContext,
  id: string,
  unclaimed: { id: string; claimedAt?: number }[],
): Promise<boolean> {
  if (!unclaimed.some((r) => r.id === id && r.claimedAt === undefined)) return false;
  await ctx.deps.store.steering.remove([id]);
  return true;
}

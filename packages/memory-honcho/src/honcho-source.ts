import type { MemoryOwner, RecallHit, RecallSource } from "@friday/core";
import {
  createConclusions,
  deleteConclusion,
  ensurePeers,
  type HonchoConnection,
  type HonchoResult,
  honchoId,
  queryConclusions,
} from "./honcho-client";

/** Id of this source in `RecallHit.source`. */
export const HONCHO_SOURCE_ID = "honcho";
/** The peer every note is about: the owner of the Friday home. */
export const HONCHO_OBSERVED_PEER = "friday-owner";
/** Default workspace: one per Friday home. */
export const HONCHO_DEFAULT_WORKSPACE = "friday";
/** Most conclusions one `forget` deletes. */
const MAX_FORGET = 200;

/** The peer that holds an owner's notes: `bot-<id>` or `group-<id>`. */
const observerOf = (o: MemoryOwner): string =>
  honchoId(o.kind === "bot" ? `bot-${o.botId}` : `group-${o.groupId}`);

/** `p`, or a rejection when `signal` aborts first (`p` itself keeps running for its other waiters). */
function within<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

/** The value of a call, or a throw with its error (the caller logs and skips the source). */
function unwrap<T>(r: HonchoResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

/**
 * Honcho as a `RecallSource`: each bot or group is an observer peer whose notes are conclusions about
 * `friday-owner`. Search is `conclusions/query` (vector search, no LLM) filtered by the query owner only, so no
 * owner sees another's notes. Peers are made once per owner; a failed attempt is tried again on the next call.
 */
export function honchoSource(c: HonchoConnection, opts: { workspace?: string } = {}): RecallSource {
  const workspace = honchoId(opts.workspace ?? HONCHO_DEFAULT_WORKSPACE);
  const ensured = new Map<string, Promise<void>>();

  /**
   * Make the owner's peers exist (cached; a failure clears the cache entry). The shared call is bounded only by the
   * client timeout, never by one caller's signal, so a search that gives up does not fail a write waiting on it.
   */
  const ensure = (observer: string, signal?: AbortSignal): Promise<void> => {
    let p = ensured.get(observer);
    if (!p) {
      p = ensurePeers(c, workspace, [observer, HONCHO_OBSERVED_PEER]).then(unwrap);
      p.catch(() => ensured.delete(observer));
      ensured.set(observer, p);
    }
    return within(p, signal);
  };

  /** Conclusions of the owner that match `text`, best first. */
  const query = async (owner: MemoryOwner, text: string, topK: number, signal?: AbortSignal) => {
    const observer = observerOf(owner);
    await ensure(observer, signal);
    const found = unwrap(
      await queryConclusions(
        c,
        workspace,
        { query: text, observerId: observer, observedId: HONCHO_OBSERVED_PEER, topK },
        signal,
      ),
    );
    // The filter is Honcho's job; checking again keeps a misbehaving server from leaking another owner's notes.
    return found.filter((x) => x.observerId === observer && x.observedId === HONCHO_OBSERVED_PEER);
  };

  return {
    id: HONCHO_SOURCE_ID,
    async search(q): Promise<RecallHit[]> {
      if (!/[\p{L}\p{N}]/u.test(q.text)) return [];
      const found = await query(q.owner, q.text, q.limit, q.signal);
      return found.map((x, i) => ({
        source: HONCHO_SOURCE_ID,
        where: HONCHO_SOURCE_ID,
        ref: x.id,
        text: x.content,
        score: 1 / (i + 1),
      }));
    },
    async write(owner, note) {
      const observer = observerOf(owner);
      await ensure(observer);
      unwrap(
        await createConclusions(c, workspace, [
          { content: note.text, observerId: observer, observedId: HONCHO_OBSERVED_PEER },
        ]),
      );
    },
    async forget(owner, text) {
      // Deleting by search: repeat until no verbatim copy is left (a query returns at most 100).
      let deleted = 0;
      while (deleted < MAX_FORGET) {
        const same = (await query(owner, text, 100)).filter((x) => x.content === text);
        if (!same.length) return;
        for (const x of same.slice(0, MAX_FORGET - deleted)) {
          unwrap(await deleteConclusion(c, workspace, x.id));
          deleted++;
        }
      }
    },
  };
}

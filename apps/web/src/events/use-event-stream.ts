import { getEventMeta } from "@orpc/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { client } from "../api/client";
import { applyEffects, type Notify } from "./apply-effects";
import { clearRuns } from "./apply-runs";
import { nextBackoff } from "./backoff";
import { reduceEvent } from "./event-reducer";

/** What the connection banner shows. */
export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline" | "resyncing";

/** Sleeps `ms`; resolves early when `signal` aborts (no dangling timer after unmount). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/** Read fresh each call (TypeScript would narrow `navigator.onLine` across awaits). */
const isOffline = () => navigator.onLine === false;

export interface UseEventStreamOptions {
  activeConversationId: string | null;
  notify: Notify;
  /** Test seam. */
  subscribe?: typeof client.events.subscribe;
  /** Test seam: wait `ms`. Must resolve early on `signal` abort when given one. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Keeps the SSE event stream open for the tab: applies each event to the query cache,
 * reconnects with exponential backoff and the last event id, refetches on `resync`.
 * `activeConversationId` and `notify` are read at apply time, so changing them never
 * restarts the stream. Mount once, in the authenticated layout.
 */
export function useEventStream(opts: UseEventStreamOptions): ConnectionState {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnectionState>("connecting");
  // Latest values, read when an event arrives (not captured by the effect).
  const live = useRef(opts);
  live.current = opts;

  useEffect(() => {
    const stop = new AbortController();
    // Resolves the current backoff wait early (back online).
    let wake: (() => void) | null = null;
    // Aborts the current stream attempt (went offline).
    let attemptCtl: AbortController | null = null;
    let attempt = 0;
    let lastEventId: string | undefined;
    // A stream has been open before: a later open is a reconnect.
    let opened = false;

    const onOffline = () => {
      setState("offline");
      attemptCtl?.abort();
    };
    const onOnline = () => {
      attempt = 0;
      wake?.();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    /** Waits the backoff (or until back online / unmount). */
    const wait = async (ms: number) => {
      const ctl = new AbortController();
      wake = () => ctl.abort();
      stop.signal.addEventListener("abort", wake);
      await (live.current.sleep ?? abortableSleep)(ms, ctl.signal);
      stop.signal.removeEventListener("abort", wake);
      wake = null;
    };

    /** Applies one payload to the cache; `resync` refetches active queries first. */
    const handle = async (payload: Parameters<typeof reduceEvent>[0]) => {
      if (payload.type === "resync") {
        setState("resyncing");
        // Runs are client-only: a stale one would never end. The status refetch restarts none,
        // so a run that is still going shows again from its next event.
        clearRuns(qc);
        await qc.refetchQueries({ type: "active" });
        if (!stop.signal.aborted) setState("live");
        return;
      }
      const { activeConversationId, notify } = live.current;
      const view = {
        activeConversationId,
        visible: document.visibilityState === "visible",
        now: Date.now(),
      };
      applyEffects(qc, reduceEvent(payload, view), notify);
    };

    const loop = async () => {
      while (!stop.signal.aborted) {
        if (isOffline()) {
          setState("offline");
        } else {
          attemptCtl = new AbortController();
          const signal = AbortSignal.any([stop.signal, attemptCtl.signal]);
          try {
            const subscribe = live.current.subscribe ?? client.events.subscribe;
            // The contract takes the id as a number; ids stay below 2^53.
            const input = lastEventId === undefined ? {} : { lastEventId: Number(lastEventId) };
            const stream = await subscribe(input, { signal });
            // An open stream is live, even when the server replays nothing.
            attempt = 0;
            setState("live");
            // A reconnect without an event id is live-only on the server: events of the gap are
            // lost, so refetch like a resync.
            if (opened && lastEventId === undefined) await handle({ type: "resync" });
            opened = true;
            for await (const payload of stream) {
              try {
                await handle(payload);
              } catch {
                // An apply error is a client bug that a reconnect cannot fix: rebuild the
                // cache from the server and keep the stream open.
                void qc.invalidateQueries();
              }
              lastEventId = getEventMeta(payload)?.id ?? lastEventId;
            }
          } catch (error) {
            // The session is gone (the client interceptor already fired): stop, no retry.
            if ((error as { code?: string } | null)?.code === "UNAUTHORIZED") return;
            // Any other error is a drop; handled below like a normal end of stream.
          }
          if (stop.signal.aborted) return;
          if (!isOffline()) setState("reconnecting");
        }
        await wait(isOffline() ? 60_000 : nextBackoff(attempt++));
      }
    };
    void loop();

    return () => {
      stop.abort();
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [qc]);

  return state;
}

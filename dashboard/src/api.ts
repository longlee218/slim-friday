import { createContext, useContext, useEffect, useState } from "react";

/** One agent run as the server sends it (see server/turn-rows.ts). */
export interface Turn {
  id: string;
  thread_id: string;
  role: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  owned_task_id: string | null;
  item_key: string | null;
  model: string | null;
  cost_usd: number | null;
  sdk_turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  outcome: string | null;
  compactions: number | null;
  tool_calls: number;
  tool_errors: number;
  last_tool: string | null;
}

/** View settings shared by every screen: time window and live polling. */
export interface Settings {
  since: number;
  live: boolean;
}
export const SettingsContext = createContext<Settings>({ since: 0, live: true });

const POLL_MS = 5000;

/** Result of a fetch: the last good data stays while a refresh runs, so polling never flickers. */
interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** GET `/api/<path>`; refetches when the path or window changes, and every POLL_MS while live. */
export function useApi<T>(path: string | null, withSince = false): ApiState<T> {
  const { since, live } = useContext(SettingsContext);
  const url = path && (withSince ? `/api/${path}?since=${since}` : `/api/${path}`);
  const [state, setState] = useState<ApiState<T>>({ data: null, error: null, loading: true });

  // A new entity (path) starts empty; a new window or a poll keeps the old frame until the new data lands.
  useEffect(() => {
    if (path) setState({ data: null, error: null, loading: true });
  }, [path]);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const load = async () => {
      try {
        const res = await fetch(url);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) setState({ data: null, error: body.error ?? res.statusText, loading: false });
        else setState({ data: body as T, error: null, loading: false });
      } catch (err) {
        if (!cancelled) setState((s) => ({ ...s, error: `server unreachable: ${String(err)}`, loading: false }));
      }
    };
    load();
    // Polls call load() directly: only a url change sets `loading`, so a poll never dims the frame.
    const timer = live ? setInterval(load, POLL_MS) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, live]);

  return state;
}

import type { MessageDto } from "@friday/contracts";
import { type InfiniteData, type QueryClient, useQuery } from "@tanstack/react-query";
import { messagesKey } from "../../events/apply-messages";
import type { RouteInfo } from "./route-info";

/** What `chat.send` takes; kept so Retry resends exactly the same payload. */
export interface SendPayload {
  conversationId: string;
  text: string;
  uploadIds?: string[];
  replyTo?: number;
}

/** Client-only state of an owner message not yet confirmed by the engine. */
export interface PendingSend {
  state: "sending" | "failed";
  payload: SendPayload;
  route: RouteInfo;
}

type Pending = Record<number, PendingSend>;

/** Cache key of the pending sends, keyed by the optimistic message's temp id. */
export const pendingKey = ["web", "pendingSends"] as const;

/** Reads the pending sends (the chat view shows "Sending…" / "Not sent · Retry" from it). */
export function usePendingSends(): Pending {
  return (
    useQuery<Pending>({
      queryKey: pendingKey,
      queryFn: () => ({}),
      initialData: {},
      staleTime: Number.POSITIVE_INFINITY,
    }).data ?? {}
  );
}

/** Sets (or with `null` removes) the pending entry of a temp id. */
export function setPending(qc: QueryClient, tempId: number, entry: PendingSend | null): void {
  qc.setQueryData<Pending>(pendingKey, (cur) => {
    const { [tempId]: _old, ...rest } = cur ?? {};
    return entry ? { ...rest, [tempId]: entry } : rest;
  });
}

type Pages = InfiniteData<MessageDto[], number | undefined>;

/**
 * Replaces the temp message by the confirmed id. When the real message already arrived by
 * event (the id is on a page) the temp one is dropped instead, so it never shows twice.
 */
export function swapTemp(
  qc: QueryClient,
  conversationId: string,
  tempId: number,
  messageId: number,
): void {
  qc.setQueryData<Pages>(messagesKey(conversationId), (data) => {
    if (!data) return data;
    const arrived = data.pages.some((p) => p.some((m) => m.id === messageId));
    const pages = data.pages.map((p) =>
      arrived
        ? p.filter((m) => m.id !== tempId)
        : p.map((m) => (m.id === tempId ? { ...m, id: messageId } : m)),
    );
    return { ...data, pages };
  });
}

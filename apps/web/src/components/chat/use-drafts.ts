import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { ReplyTarget } from "./composer";

/** Cache keys of the client-only composer state, one record per kind keyed by conversation id. */
export const draftsKey = ["web", "drafts"] as const;
export const repliesKey = ["web", "replies"] as const;

/**
 * One conversation's entry of a client-only record in the query cache. It lives outside the
 * chat component, so a width crossing (desktop chat unmounts, phone chat mounts) keeps it.
 * `gcTime: Infinity` keeps it while no chat is mounted. Setting `undefined` removes the entry.
 */
function useEntry<T>(key: readonly unknown[], id: string) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => ({}) as Record<string, T>,
    enabled: false,
    gcTime: Number.POSITIVE_INFINITY,
    select: (r: Record<string, T>) => r[id],
  });
  const set = useCallback(
    (value: T | undefined) =>
      qc.setQueryData<Record<string, T>>(key, (cur) => {
        const { [id]: _old, ...rest } = cur ?? {};
        return value === undefined ? rest : { ...rest, [id]: value };
      }),
    [qc, key, id],
  );
  return [data, set] as const;
}

/** The composer text of a conversation and its setter (an empty text drops the entry). */
export function useDraft(conversationId: string): readonly [string, (text: string) => void] {
  const [draft, set] = useEntry<string>(draftsKey, conversationId);
  return [draft ?? "", (text) => set(text === "" ? undefined : text)];
}

/** The bot message the owner is replying to in a conversation, and its setter (`null` clears). */
export function useReplyTarget(
  conversationId: string,
): readonly [ReplyTarget | null, (target: ReplyTarget | null) => void] {
  const [target, set] = useEntry<ReplyTarget>(repliesKey, conversationId);
  return [target ?? null, (t) => set(t ?? undefined)];
}

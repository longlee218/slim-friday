import { useInfiniteQuery } from "@tanstack/react-query";
import { orpc } from "../../api/client";
import { MESSAGES_PAGE } from "../../events/apply-messages";

/**
 * The messages of a conversation, newest page first. The input shape is exactly the one
 * `messagesKey` builds (`apply-messages.ts`): live events write into the same cache entry,
 * so any other shape would silently stop live updates. `enabled` is false for an unknown id.
 */
export function useConversationMessages(conversationId: string, enabled = true) {
  return useInfiniteQuery(
    orpc.conversations.messages.infiniteOptions({
      input: (before: number | undefined) => ({ id: conversationId, before, limit: MESSAGES_PAGE }),
      initialPageParam: undefined,
      enabled,
      // `before` is the id of the oldest message held; a short page means the start was reached.
      getNextPageParam: (last) =>
        last.length < MESSAGES_PAGE ? undefined : last[last.length - 1]?.id,
    }),
  );
}

import type { ConversationDto, MessageDto } from "@friday/contracts";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { orpc } from "../api/client";

/** Page size of the transcript query; the transcript hook must use the same value. */
export const MESSAGES_PAGE = 50;

/** Infinite-query key of a conversation's messages (same input shape as the transcript hook). */
export function messagesKey(conversationId: string) {
  return orpc.conversations.messages.infiniteKey({
    input: (before: number | undefined) => ({ id: conversationId, before, limit: MESSAGES_PAGE }),
    initialPageParam: undefined,
  });
}

/**
 * Puts a pushed message first in page 0 (pages are newest first) unless any page already
 * holds its id, and mirrors it as `lastMessage` in the conversation list.
 */
export function appendMessage(qc: QueryClient, message: MessageDto): void {
  qc.setQueryData<InfiniteData<MessageDto[], number | undefined>>(
    messagesKey(message.conversationId),
    (data) => {
      // Nothing loaded yet: the first fetch will include the message.
      if (!data || data.pages.some((p) => p.some((m) => m.id === message.id))) return data;
      const [first = [], ...rest] = data.pages;
      return { ...data, pages: [[message, ...first], ...rest] };
    },
  );
  qc.setQueryData<ConversationDto[]>(orpc.conversations.list.queryKey(), (list) =>
    list?.map((c) =>
      c.id === message.conversationId && (c.lastMessage?.id ?? -1) < message.id
        ? { ...c, lastMessage: message }
        : c,
    ),
  );
}

/** Sets the unread badge of one conversation as the server counted it. */
export function setUnread(qc: QueryClient, conversationId: string, unread: number): void {
  qc.setQueryData<ConversationDto[]>(orpc.conversations.list.queryKey(), (list) =>
    list?.map((c) => (c.id === conversationId ? { ...c, unread } : c)),
  );
}

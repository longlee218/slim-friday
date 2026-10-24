import type { ConversationDto, MessageDto } from "@friday/contracts";
import type { Conversation, IndexedMessage, Store } from "@friday/core";
import { toMessageDto } from "@friday/surface-web";
import { authed } from "../rpc/implementer";

/** Messages as DTOs; a reply quotes its target only when that message is in the same conversation. */
async function toDtos(store: Store, msgs: IndexedMessage[]): Promise<MessageDto[]> {
  return Promise.all(
    msgs.map(async (m) => {
      const target = m.replyTo === undefined ? undefined : await store.messages.get(m.replyTo);
      return toMessageDto(m, target?.conversationId === m.conversationId ? target : undefined);
    }),
  );
}

/** One conversation for the sidebar; undefined when its bot or group no longer exists. */
async function toConversationDto(
  store: Store,
  c: Conversation,
): Promise<ConversationDto | undefined> {
  const owner =
    c.kind === "direct" ? await store.bots.get(c.botId) : await store.groups.get(c.groupId);
  if (!owner) return undefined;
  const [last] = await toDtos(store, await store.messages.page(c.id, { limit: 1 }));
  return {
    id: c.id,
    kind: c.kind,
    ...(c.kind === "direct" ? { botId: c.botId } : { groupId: c.groupId }),
    title: owner.name,
    ...(last && { lastMessage: last }),
    unread: await store.reads.unread(c.id),
  };
}

/** Conversation list, message history and read marks. */
export const conversationsRouter = {
  /** Direct chats first, then groups, each by title. */
  list: authed.conversations.list.handler(async ({ context }) => {
    const { store } = context.deps;
    const all = await Promise.all(
      (await store.conversations.list()).map((c) => toConversationDto(store, c)),
    );
    const rank = (c: ConversationDto) => (c.kind === "direct" ? 0 : 1);
    return all
      .filter((c): c is ConversationDto => c !== undefined)
      .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  }),
  messages: authed.conversations.messages.handler(async ({ input, context, errors }) => {
    const { store } = context.deps;
    if (!(await store.conversations.get(input.id))) throw errors.NOT_FOUND();
    const page = await store.messages.page(input.id, {
      ...(input.before !== undefined && { before: input.before }),
      limit: input.limit,
    });
    return toDtos(store, page);
  }),
  markRead: authed.conversations.markRead.handler(async ({ input, context, errors }) => {
    const { store } = context.deps;
    if (!(await store.conversations.get(input.id))) throw errors.NOT_FOUND();
    await store.reads.set(input.id, input.messageId);
    return { ok: true as const };
  }),
};

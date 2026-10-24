import { authed } from "../rpc/implementer";
import { botStatusDtos } from "./bot-status-dto";

/** Status, stop and purge. */
export const controlRouter = {
  status: authed.control.status.handler(({ context }) => botStatusDtos(context.deps)),
  /**
   * `botId` stops all of that bot's sessions; a conversation id stops that conversation's sessions. Stored cards
   * stay open (withdrawing them with their parked runs is the cross-process stop's job).
   */
  stop: authed.control.stop.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    const sessions = () => hub.status();
    if (input.botId) {
      if (!(await store.bots.get(input.botId))) throw errors.NOT_FOUND();
      const n = sessions().filter((s) => s.botId === input.botId).length;
      await hub.stop(input.botId);
      return { stopped: n };
    }
    if (!input.conversationId) throw errors.BAD_REQUEST();
    const conv = await store.conversations.get(input.conversationId);
    if (!conv) throw errors.NOT_FOUND();
    if (conv.kind === "direct") {
      const n = sessions().filter((s) => s.botId === conv.botId && !s.groupId).length;
      await hub.stop(conv.botId, "direct");
      return { stopped: n };
    }
    const n = sessions().filter((s) => s.groupId === conv.groupId).length;
    await hub.stopGroup(conv.groupId);
    return { stopped: n };
  }),
  purge: authed.control.purge.handler(({ context }) => ({ purged: context.deps.purge() })),
};

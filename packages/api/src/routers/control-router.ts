import { authed } from "../rpc/implementer";
import { botStatusDtos } from "./bot-status-dto";

/** Status, stop and purge. */
export const controlRouter = {
  status: authed.control.status.handler(({ context }) => botStatusDtos(context.deps)),
  /**
   * `botId` stops all of that bot's runs; a conversation id stops that conversation's runs (queued, running and
   * parked, in any process). Their cards are withdrawn. `stopped` counts the runs cancelled.
   */
  stop: authed.control.stop.handler(async ({ input, context, errors }) => {
    const { hub, store } = context.deps;
    if (input.botId) {
      if (!(await store.bots.get(input.botId))) throw errors.NOT_FOUND();
      return { stopped: await hub.stop(input.botId) };
    }
    if (!input.conversationId) throw errors.BAD_REQUEST();
    const conv = await store.conversations.get(input.conversationId);
    if (!conv) throw errors.NOT_FOUND();
    if (conv.kind === "direct") return { stopped: await hub.stop(conv.botId, "direct") };
    return { stopped: await hub.stopGroup(conv.groupId) };
  }),
  toolCheck: authed.control.toolCheck.handler(({ context }) => context.deps.toolWarnings),
  purge: authed.control.purge.handler(({ context }) => ({ purged: context.deps.purge() })),
};

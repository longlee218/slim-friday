import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { toBotDto } from "./to-dto";

/** Bot config over the settings admin; avatar URLs and `setAvatar` come with the avatars task. */
export const botsRouter = {
  list: authed.config.bots.list.handler(({ context }) =>
    context.deps.settings.config.listBots().map((b) => toBotDto(b)),
  ),
  get: authed.config.bots.get.handler(async ({ input, context }) =>
    toBotDto(await adminCall(() => context.deps.settings.config.getBot(input.id))),
  ),
  save: authed.config.bots.save.handler(async ({ input, context }) => {
    const { config } = context.deps.settings;
    return toBotDto(
      await adminCall(() => {
        config.saveBot({ id: input.id, ...input.bot }, input.mode);
        return config.getBot(input.id);
      }),
    );
  }),
  delete: authed.config.bots.delete.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.deleteBot(input.id));
    return { ok: true as const };
  }),
};

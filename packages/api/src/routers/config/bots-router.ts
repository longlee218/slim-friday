import type { ApiDeps } from "../../app";
import { avatarUrlOf } from "../../avatar-url";
import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { applyAvatar } from "./avatars-router";
import { toBotDto } from "./to-dto";

/** One bot as a DTO, with its avatar URL. */
async function botDto(deps: ApiDeps, id: string) {
  const b = await adminCall(() => deps.settings.config.getBot(id));
  return toBotDto(b, await avatarUrlOf(deps, b.avatar, { kind: "bot", id: b.id }));
}

/** Bot config over the settings admin. */
export const botsRouter = {
  list: authed.config.bots.list.handler(({ context }) =>
    Promise.all(
      context.deps.settings.config
        .listBots()
        .map(async (b) =>
          toBotDto(b, await avatarUrlOf(context.deps, b.avatar, { kind: "bot", id: b.id })),
        ),
    ),
  ),
  get: authed.config.bots.get.handler(({ input, context }) => botDto(context.deps, input.id)),
  setAvatar: authed.config.bots.setAvatar.handler(async ({ input, context }) => {
    const { id, ...choice } = input;
    await applyAvatar(context.deps, { kind: "bot", id }, choice);
    return botDto(context.deps, id);
  }),
  save: authed.config.bots.save.handler(async ({ input, context }) => {
    const { config } = context.deps.settings;
    await adminCall(() => config.saveBot({ id: input.id, ...input.bot }, input.mode));
    return botDto(context.deps, input.id);
  }),
  delete: authed.config.bots.delete.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.deleteBot(input.id));
    return { ok: true as const };
  }),
};

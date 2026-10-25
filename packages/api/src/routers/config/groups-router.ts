import type { ApiDeps } from "../../app";
import { avatarUrlOf } from "../../avatar-url";
import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { applyAvatar } from "./avatars-router";
import { toGroupDto } from "./to-dto";

/** One group as a DTO, with its avatar URL. */
async function groupDto(deps: ApiDeps, id: string) {
  const g = await adminCall(() => deps.settings.config.getGroup(id));
  return toGroupDto(g, await avatarUrlOf(deps, g.avatar, { kind: "group", id: g.id }));
}

/** Group config over the settings admin. */
export const groupsRouter = {
  list: authed.config.groups.list.handler(({ context }) =>
    Promise.all(
      context.deps.settings.config
        .listGroups()
        .map(async (g) =>
          toGroupDto(g, await avatarUrlOf(context.deps, g.avatar, { kind: "group", id: g.id })),
        ),
    ),
  ),
  get: authed.config.groups.get.handler(({ input, context }) => groupDto(context.deps, input.id)),
  setAvatar: authed.config.groups.setAvatar.handler(async ({ input, context }) => {
    const { id, ...choice } = input;
    await applyAvatar(context.deps, { kind: "group", id }, choice);
    return groupDto(context.deps, id);
  }),
  save: authed.config.groups.save.handler(async ({ input, context }) => {
    const { config } = context.deps.settings;
    await adminCall(() => config.saveGroup({ id: input.id, ...input.group }, input.mode));
    return groupDto(context.deps, input.id);
  }),
  delete: authed.config.groups.delete.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.deleteGroup(input.id));
    return { ok: true as const };
  }),
};

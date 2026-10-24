import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { toGroupDto } from "./to-dto";

/** Group config over the settings admin; avatar URLs and `setAvatar` come with the avatars task. */
export const groupsRouter = {
  list: authed.config.groups.list.handler(({ context }) =>
    context.deps.settings.config.listGroups().map((g) => toGroupDto(g)),
  ),
  get: authed.config.groups.get.handler(async ({ input, context }) =>
    toGroupDto(await adminCall(() => context.deps.settings.config.getGroup(input.id))),
  ),
  save: authed.config.groups.save.handler(async ({ input, context }) => {
    const { config } = context.deps.settings;
    return toGroupDto(
      await adminCall(() => {
        config.saveGroup({ id: input.id, ...input.group }, input.mode);
        return config.getGroup(input.id);
      }),
    );
  }),
  delete: authed.config.groups.delete.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.deleteGroup(input.id));
    return { ok: true as const };
  }),
};

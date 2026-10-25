import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";
import { toSkillDto } from "./to-dto";

/** Skills: a lookup first, an install only with the lookup id the owner confirmed. */
export const skillsRouter = {
  list: authed.config.skills.list.handler(({ context }) =>
    context.deps.settings.skills.list().map(toSkillDto),
  ),
  lookup: authed.config.skills.lookup.handler(({ input, context }) =>
    adminCall(() => context.deps.settings.skills.lookup(input.source, input.path)),
  ),
  install: authed.config.skills.install.handler(async ({ input, context }) =>
    toSkillDto(
      await adminCall(() => context.deps.settings.skills.install(input.lookupId, input.name)),
    ),
  ),
  checkUpdate: authed.config.skills.checkUpdate.handler(({ input, context }) =>
    adminCall(() => context.deps.settings.skills.checkUpdate(input.name)),
  ),
  update: authed.config.skills.update.handler(async ({ input, context }) =>
    toSkillDto(
      await adminCall(() => context.deps.settings.skills.update(input.lookupId, input.name)),
    ),
  ),
  remove: authed.config.skills.remove.handler(({ input, context }) =>
    adminCall(() => context.deps.settings.skills.remove(input.name)),
  ),
  setUsedBy: authed.config.skills.setUsedBy.handler(async ({ input, context }) =>
    toSkillDto(
      await adminCall(() => context.deps.settings.skills.setUsedBy(input.name, input.botIds)),
    ),
  ),
};

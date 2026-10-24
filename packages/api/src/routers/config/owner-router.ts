import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";

/** USER.md and SOUL.md (the contract already limits `text` to 20,000 characters). */
export const ownerRouter = {
  get: authed.config.owner.get.handler(async ({ input, context }) => ({
    file: input.file,
    text: await adminCall(() => context.deps.settings.config.readOwnerFile(input.file)),
  })),
  save: authed.config.owner.save.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.saveOwnerFile(input.file, input.text));
    return { ok: true as const };
  }),
};

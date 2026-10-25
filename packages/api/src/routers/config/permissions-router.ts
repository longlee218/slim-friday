import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";

/** The permission switches of `settings.yaml` (spec §6.14): read, and Auto Review on or off. */
export const permissionsRouter = {
  get: authed.config.permissions.get.handler(async ({ context }) =>
    adminCall(() => context.deps.settings.permissions.get()),
  ),
  setAutoReview: authed.config.permissions.setAutoReview.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.permissions.setAutoReview(input.autoReview));
    return { ok: true as const };
  }),
};

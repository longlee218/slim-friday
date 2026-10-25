import { authed } from "../../rpc/implementer";
import { adminCall } from "./admin-error";

/** The models the runtime offers (the bot form's picker). */
export const modelsRouter = {
  list: authed.config.models.list.handler(async ({ context }) =>
    adminCall(() => context.deps.settings.models()),
  ),
};

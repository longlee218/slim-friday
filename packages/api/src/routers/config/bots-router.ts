import { authed } from "../../rpc/implementer";
import { toBotDto } from "./to-dto";

/** Bot config; read only for now (plan 5 adds get, save, delete, setAvatar). */
export const botsRouter = {
  list: authed.config.bots.list.handler(async ({ context }) =>
    (await context.deps.store.bots.list()).map(toBotDto),
  ),
};

import { authed } from "../../rpc/implementer";
import { toGroupDto } from "./to-dto";

/** Group config; read only for now (plan 5 adds get, save, delete, setAvatar). */
export const groupsRouter = {
  list: authed.config.groups.list.handler(async ({ context }) =>
    (await context.deps.listGroups()).map(toGroupDto),
  ),
};

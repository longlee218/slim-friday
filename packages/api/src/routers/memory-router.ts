import { authed } from "../rpc/implementer";
import { adminCall } from "./config/admin-error";
import { parseOwner } from "./memory-owner";

/** Memory notes, journal and rules of a bot or group, over `MemoryAdmin`. */
export const memoryRouter = {
  // Kind and text filters run here, after the admin lists the owner's notes.
  list: authed.memory.list.handler(async ({ input, context }) => {
    const o = parseOwner(context.deps, input.owner);
    const r = await adminCall(() => context.deps.settings.memory.list(o));
    const q = input.query?.toLowerCase();
    const notes = r.notes.filter(
      (n) =>
        (input.kind === undefined || n.kind === input.kind) &&
        (q === undefined || n.text.toLowerCase().includes(q)),
    );
    return { ...r, notes };
  }),
  save: authed.memory.save.handler(async ({ input, context }) => {
    const o = parseOwner(context.deps, input.owner);
    await adminCall(() => context.deps.settings.memory.save(o, input.kind, input.text));
    return { ok: true as const };
  }),
  edit: authed.memory.edit.handler(async ({ input, context }) => {
    const o = parseOwner(context.deps, input.owner);
    await adminCall(() => context.deps.settings.memory.edit(o, input.id, input.text));
    return { ok: true as const };
  }),
  delete: authed.memory.delete.handler(async ({ input, context }) => {
    const o = parseOwner(context.deps, input.owner);
    await adminCall(() => context.deps.settings.memory.delete(o, input.id));
    return { ok: true as const };
  }),
  journal: authed.memory.journal.handler(({ input, context }) => {
    const o = parseOwner(context.deps, input.owner);
    return adminCall(() => context.deps.settings.memory.journal(o, input.day));
  }),
  // The contract schema already refuses more than 50 rules and long or multi-line ones.
  rules: {
    get: authed.memory.rules.get.handler(({ input, context }) => {
      const o = parseOwner(context.deps, input.owner);
      return adminCall(() => context.deps.settings.memory.rules(o));
    }),
    save: authed.memory.rules.save.handler(async ({ input, context }) => {
      const o = parseOwner(context.deps, input.owner);
      await adminCall(() => context.deps.settings.memory.saveRules(o, input.rules));
      return { ok: true as const };
    }),
  },
};

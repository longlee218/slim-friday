import { redactSecrets, type ScratchpadItem, secretsFrom } from "@friday/core";
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

/** Open and parked items only (done ones are history). */
const shown = (i: ScratchpadItem): i is ScratchpadItem & { status: "open" | "parked" } =>
  i.status !== "done";

/** The bot's scratchpad per scope: the direct list, then one per group it is a member of (empty ones left out). */
async function scratchpadOf(deps: ApiDeps, botId: string) {
  const { store, settings } = deps;
  const scopes: { scope: "direct" | { groupId: string; name: string }; key: string }[] = [
    { scope: "direct", key: botId },
    ...settings.config
      .listGroups()
      .filter((g) => g.members.includes(botId))
      .map((g) => ({ scope: { groupId: g.id, name: g.name }, key: `${botId}@${g.id}` })),
  ];
  const lists = await Promise.all(
    scopes.map(async (s) => ({
      scope: s.scope,
      items: (await store.scratchpad.list(s.key)).filter(shown),
    })),
  );
  // Items are bot-written text: secrets are hidden as in everything else a bot posts (spec §6.11).
  const secrets = secretsFrom(deps.secretValues);
  return lists
    .filter((l) => l.items.length > 0)
    .map((l) => ({
      scope: l.scope,
      items: l.items.map(({ id, title, status, notes, updatedAt }) => ({
        id,
        title: redactSecrets(title, secrets),
        status,
        notes: redactSecrets(notes, secrets),
        updatedAt,
      })),
    }));
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
  scratchpad: authed.config.bots.scratchpad.handler(async ({ input, context }) => {
    await adminCall(() => context.deps.settings.config.getBot(input.id));
    return scratchpadOf(context.deps, input.id);
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

import type { ApprovalRuleDto } from "@friday/contracts";
import { exactHost, type Grant } from "@friday/core";
import { ORPCError } from "@orpc/server";
import { authed } from "../../rpc/implementer";

/** The DTO of a stored owner rule. */
const toDto = (g: Grant): ApprovalRuleDto => ({
  id: g.id,
  botId: g.botId,
  effect: g.effect,
  match: g.match,
  value: g.tool,
  scope: g.scope,
  createdAt: g.createdAt,
});

/** Owner rules (spec §6.14): the settings list, add and remove. Input shapes are checked by the contract. */
export const approvalRulesRouter = {
  list: authed.config.approvalRules.list.handler(async ({ context }) =>
    (await context.deps.store.grants.all()).map(toDto),
  ),
  add: authed.config.approvalRules.add.handler(async ({ input, context }) => {
    const { store, now } = context.deps;
    // A fetch is matched by its url's registrable domain, so a rule for a subdomain or a public suffix never matches.
    const domainOf = context.deps.registrableDomain ?? exactHost;
    if (input.match === "site" && domainOf(input.value) !== input.value)
      throw new ORPCError("BAD_REQUEST", {
        message: "Use the site's registrable domain (e.g. example.com).",
        data: { field: "value" },
      });
    if (input.botId !== "*" && !(await store.bots.get(input.botId)))
      throw new ORPCError("NOT_FOUND", { message: `No bot ${input.botId}.` });
    const at = now();
    const rule: Grant = {
      id: `rule-${crypto.randomUUID()}`,
      botId: input.botId,
      effect: input.effect,
      match: input.match,
      tool: input.value,
      scope: input.match === "tool" ? input.scope : {},
      createdAt: at,
    };
    await store.grants.add(rule);
    return toDto(rule);
  }),
  remove: authed.config.approvalRules.remove.handler(async ({ input, context }) => {
    const { store } = context.deps;
    if (!(await store.grants.all()).some((g) => g.id === input.id))
      throw new ORPCError("NOT_FOUND", { message: "No such rule." });
    await store.grants.revoke(input.id);
    return { ok: true as const };
  }),
};

import { z } from "zod";
import { BotIdSchema, McpNameSchema } from "../ids";

/** What an owner rule does (spec §6.14). */
export const RuleEffectSchema = z.enum(["always_allow", "require_approval"]);
/** What an owner rule matches on; site 4 > tool 3 > server 2 > category 1. */
export const RuleMatchSchema = z.enum(["site", "tool", "server", "category"]);
/** The categories a `category` rule can name. */
export const RuleCategorySchema = z.enum(["email", "purchase"]);
/** The bots a rule is for: one bot id, or `*` for every bot. */
export const RuleBotSchema = z.union([BotIdSchema, z.literal("*")]);

/** A site: a lower-case host name of two or more labels (the registrable domain, e.g. `example.com`). */
export const RuleSiteSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/);
/** A tool name as the bot calls it (`Bash`, `mcp__github__create_issue`). */
export const RuleToolSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,199}$/);
/** Most scope keys of a tool rule. */
const MAX_SCOPE_KEYS = 20;
/** A tool rule's scope: key to value; `*` as a value matches anything. */
export const RuleScopeSchema = z
  .record(z.string().min(1).max(64), z.string().max(500))
  .refine((s) => Object.keys(s).length <= MAX_SCOPE_KEYS, { message: "too many scope keys" });

/** One owner rule as the settings list shows it. `value` is the site, tool, server or category. */
export const ApprovalRuleDtoSchema = z.object({
  id: z.string(),
  botId: z.string(),
  effect: RuleEffectSchema,
  match: RuleMatchSchema,
  value: z.string(),
  scope: z.record(z.string(), z.string()),
  createdAt: z.number(),
});
export type ApprovalRuleDto = z.infer<typeof ApprovalRuleDtoSchema>;

/** Fields of every new rule. */
const common = { botId: RuleBotSchema.default("*"), effect: RuleEffectSchema };

/** A new owner rule; the value is checked by its match kind, and only a tool rule has a scope. */
export const ApprovalRuleInputSchema = z.discriminatedUnion("match", [
  z.object({ ...common, match: z.literal("site"), value: RuleSiteSchema }),
  z.object({
    ...common,
    match: z.literal("tool"),
    value: RuleToolSchema,
    scope: RuleScopeSchema.default({}),
  }),
  z.object({ ...common, match: z.literal("server"), value: McpNameSchema }),
  z.object({ ...common, match: z.literal("category"), value: RuleCategorySchema }),
]);
export type ApprovalRuleInput = z.input<typeof ApprovalRuleInputSchema>;

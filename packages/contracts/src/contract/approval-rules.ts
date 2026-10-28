import { z } from "zod";
import {
  ApprovalRuleDtoSchema,
  ApprovalRuleInputSchema,
  RuleEffectSchema,
} from "../dto/approval-rules";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";

const RuleIdSchema = z.string().min(1).max(200);

/** Owner rules (spec §6.14): list, add, remove, switch effect. Rules never expire. */
export const approvalRules = {
  list: base.output(z.array(ApprovalRuleDtoSchema)),
  add: base.input(ApprovalRuleInputSchema).output(ApprovalRuleDtoSchema),
  remove: base.input(z.object({ id: RuleIdSchema })).output(OkDtoSchema),
  setEffect: base
    .input(z.object({ id: RuleIdSchema, effect: RuleEffectSchema }))
    .output(ApprovalRuleDtoSchema),
  /** Tool name to its scope keys (`tools.yaml` `scopeKeys`), for every catalog tool; empty when it has none. */
  scopeKeys: base.output(z.record(z.string(), z.array(z.string()))),
};

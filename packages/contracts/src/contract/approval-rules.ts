import { z } from "zod";
import { ApprovalRuleDtoSchema, ApprovalRuleInputSchema } from "../dto/approval-rules";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";

/** Owner rules (spec §6.14): list, add, remove. Rules never expire. */
export const approvalRules = {
  list: base.output(z.array(ApprovalRuleDtoSchema)),
  add: base.input(ApprovalRuleInputSchema).output(ApprovalRuleDtoSchema),
  remove: base.input(z.object({ id: z.string().min(1).max(200) })).output(OkDtoSchema),
};

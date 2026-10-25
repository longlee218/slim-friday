import { BotIdSchema, type BotInputDto, BotInputDtoSchema } from "@friday/contracts";
import type { FieldErrors } from "./use-form-state";

/** What the bot form edits: the saved fields plus the id (typed once, when the bot is new). */
export type BotFormValue = BotInputDto & { id: string };

/** The same limit `InlineName` enforces. */
export const NAME_HELP = "Use 1 to 32 characters.";

/** The values of a bot that does not exist yet. */
export const NEW_BOT: BotFormValue = {
  id: "",
  name: "",
  title: "",
  instructions: "",
  model: "sonnet",
  tools: [],
  skills: [],
  workspaces: [],
};

/** Validates with the contract: `BotInputDtoSchema` for the fields, `BotIdSchema` for the id. */
export function validateBot(v: BotFormValue): FieldErrors<BotFormValue> {
  const errors: FieldErrors<BotFormValue> = {};
  const { id: _id, ...input } = v;
  const parsed = BotInputDtoSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof BotFormValue | undefined;
      if (key && !errors[key]) errors[key] = issue.message;
    }
  }
  if (v.name.trim().length < 1 || v.name.length > 32) errors.name = NAME_HELP;
  if (!BotIdSchema.safeParse(v.id).success) {
    errors.id = "Lowercase letters, digits and dashes; start with a letter; up to 32.";
  }
  return errors;
}

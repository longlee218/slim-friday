import { z } from "zod";
import { ModelDtoSchema, PermissionsDtoSchema } from "../dto/permissions";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";

/** Read the permission switches; set Auto Review on or off (written to the owner's settings.yaml). */
export const permissions = {
  get: base.output(PermissionsDtoSchema),
  setAutoReview: base.input(z.object({ autoReview: z.boolean() })).output(OkDtoSchema),
};

/** The models the Claude runtime offers, for the bot form's model picker. */
export const models = {
  list: base.output(z.array(ModelDtoSchema)),
};

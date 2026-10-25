import { z } from "zod";
import { PermissionsDtoSchema } from "../dto/permissions";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";

/** Read the permission switches; set Auto Review on or off (written to the owner's settings.yaml). */
export const permissions = {
  get: base.output(PermissionsDtoSchema),
  setAutoReview: base.input(z.object({ autoReview: z.boolean() })).output(OkDtoSchema),
};

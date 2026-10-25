import { z } from "zod";

/** The permission switches of `settings.yaml` (spec §6.14). */
export const PermissionsDtoSchema = z.object({
  /** Auto Review: a model may clear a plain approval ask; off by default. */
  autoReview: z.boolean(),
});
export type PermissionsDto = z.infer<typeof PermissionsDtoSchema>;

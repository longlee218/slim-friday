import { z } from "zod";

/** The permission switches of `settings.yaml` (spec §6.14). */
export const PermissionsDtoSchema = z.object({
  /** Auto Review: a model may clear a plain approval ask; off by default. */
  autoReview: z.boolean(),
});
export type PermissionsDto = z.infer<typeof PermissionsDtoSchema>;

/** A model a bot may use, as the Claude runtime lists it. */
export const ModelDtoSchema = z.object({
  /** What a bot's `model` holds: an alias (`sonnet`) or a full id. */
  value: z.string(),
  displayName: z.string(),
  description: z.string(),
  /** The full id an alias stands for. */
  resolvedModel: z.string().optional(),
  efforts: z.array(z.string()).optional(),
});
export type ModelDto = z.infer<typeof ModelDtoSchema>;

import { z } from "zod";

/** One open or parked item of a bot's scratchpad (read only in the web app). */
export const ScratchpadItemDtoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "parked"]),
  notes: z.string(),
  updatedAt: z.number(),
});
export type ScratchpadItemDto = z.infer<typeof ScratchpadItemDtoSchema>;

/** The items of one scope of a bot: its direct chat, or one group it belongs to. */
export const ScratchpadScopeDtoSchema = z.object({
  scope: z.union([z.literal("direct"), z.object({ groupId: z.string(), name: z.string() })]),
  items: z.array(ScratchpadItemDtoSchema),
});
export type ScratchpadScopeDto = z.infer<typeof ScratchpadScopeDtoSchema>;

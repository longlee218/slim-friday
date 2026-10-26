import { z } from "zod";
import {
  AvatarPresetDtoSchema,
  BotDtoSchema,
  BotInputDtoSchema,
  GroupDtoSchema,
  GroupInputDtoSchema,
  UploadTicketDtoSchema,
} from "../dto/config";
import { ScratchpadScopeDtoSchema } from "../dto/scratchpad";
import { OkDtoSchema } from "../dto/status";
import { base } from "../errors";
import { BotIdSchema } from "../ids";

const id = BotIdSchema;
const mode = z.enum(["create", "update"]);

/** `setAvatar` for a bot: exactly one of `preset` or `uploadId`. */
const botAvatar = z
  .object({ id, preset: z.string().optional(), uploadId: z.uuid().optional() })
  .refine((v) => [v.preset, v.uploadId].filter((x) => x !== undefined).length === 1, {
    message: "exactly one of preset, uploadId",
  });

/** `setAvatar` for a group: exactly one of `preset`, `uploadId` or `none`. */
const groupAvatar = z
  .object({
    id,
    preset: z.string().optional(),
    uploadId: z.uuid().optional(),
    none: z.literal(true).optional(),
  })
  .refine((v) => [v.preset, v.uploadId, v.none].filter((x) => x !== undefined).length === 1, {
    message: "exactly one of preset, uploadId, none",
  });

/** Bot files in the config dir. */
export const bots = {
  list: base.output(z.array(BotDtoSchema)),
  get: base.input(z.object({ id })).output(BotDtoSchema),
  save: base.input(z.object({ id, bot: BotInputDtoSchema, mode })).output(BotDtoSchema),
  /** `cascade` also takes the bot out of its groups (a one-member group is deleted). */
  delete: base.input(z.object({ id, cascade: z.boolean().optional() })).output(OkDtoSchema),
  setAvatar: base.input(botAvatar).output(BotDtoSchema),
  /** Open and parked scratchpad items of the bot, per scope (direct first, then its groups). */
  scratchpad: base.input(z.object({ id })).output(z.array(ScratchpadScopeDtoSchema)),
};

/** Group files in the config dir. */
export const groups = {
  list: base.output(z.array(GroupDtoSchema)),
  get: base.input(z.object({ id })).output(GroupDtoSchema),
  save: base.input(z.object({ id, group: GroupInputDtoSchema, mode })).output(GroupDtoSchema),
  delete: base.input(z.object({ id })).output(OkDtoSchema),
  setAvatar: base.input(groupAvatar).output(GroupDtoSchema),
};

/** Avatar presets and upload tickets. `image/jpeg` is the Safari fallback (owner decision). */
export const avatars = {
  list: base.output(z.array(AvatarPresetDtoSchema)),
  create: base
    .input(
      z.object({
        kind: z.enum(["bot", "group"]),
        id,
        size: z.number().int().positive(),
        type: z.enum(["image/webp", "image/jpeg"]),
      }),
    )
    .output(UploadTicketDtoSchema),
};

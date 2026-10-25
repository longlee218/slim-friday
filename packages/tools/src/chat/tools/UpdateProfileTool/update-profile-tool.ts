import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { ChatContext } from "../../chat-context";
import { UPDATE_PROFILE_TOOL } from "./constants";
import { ProfileRefused, updateProfile } from "./profile-file";
import { UPDATE_PROFILE_DESCRIPTION } from "./prompt";

/** Input the model sees; there is no bot id: the tool acts for the calling bot only. */
const SHAPE = {
  title: z.string().optional().describe("A short role, e.g. Code reviewer."),
  description: z
    .string()
    .optional()
    .describe("One line (at most 500 chars) about what you are for."),
};

/** `UpdateProfile` for one session: writes the title and description into the calling bot's own file. */
export function createUpdateProfileTool(ctx: ChatContext) {
  return tool(UPDATE_PROFILE_TOOL, UPDATE_PROFILE_DESCRIPTION, SHAPE, async (input) => {
    if (!ctx.profile) return textResult("Refused: this session cannot change its profile.", true);
    try {
      updateProfile(ctx.profile, ctx.botId, { title: input.title, description: input.description });
    } catch (err) {
      if (err instanceof ProfileRefused) return textResult(`Refused: ${err.message}`, true);
      return textResult("Refused: the profile could not be saved.", true);
    }
    return textResult("Profile updated. It shows in the teammate directory after the next reload.");
  });
}

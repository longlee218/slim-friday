import { lstatSync } from "node:fs";
import { basename } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { checkInsideWorkspace } from "../../../effects/workspace-paths";
import { textResult } from "../../../tool-result";
import type { ChatContext } from "../../chat-context";
import { POST_FILE_MAX_BYTES, POST_FILE_TOOL } from "./constants";
import { POST_FILE_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  path: z.string().min(1).describe("Absolute path of the file."),
  caption: z.string().max(500).optional().describe("Short text sent with the file."),
};

/** `PostFile` for one session: only a regular file strictly inside the bot's workspaces or scratch dir goes out. */
export function createPostFileTool(ctx: ChatContext) {
  return tool(
    POST_FILE_TOOL,
    POST_FILE_DESCRIPTION,
    SHAPE,
    async ({ path, caption }) => {
      const conversationId = ctx.conversation();
      if (!conversationId)
        return textResult("Refused: no conversation is waiting for a file.", true);
      // Same checks as the effect tools: absolute, not a link, strictly inside a root, no git dir, not secret.
      const c = checkInsideWorkspace(path, [...ctx.workspaces, ctx.scratchDir], ctx.isSensitive);
      if (typeof c === "string") return textResult(`Refused: ${c}`, true);
      let size: number;
      try {
        const st = lstatSync(c.real);
        if (!st.isFile()) return textResult(`Refused: not a regular file: ${path}`, true);
        size = st.size;
      } catch {
        return textResult(`Refused: cannot read: ${path}`, true);
      }
      if (size > POST_FILE_MAX_BYTES)
        return textResult(`Refused: over ${POST_FILE_MAX_BYTES / 1024 / 1024} MB: ${path}`, true);
      try {
        await ctx.postFile(
          conversationId,
          ctx.botId,
          { path: c.real, name: basename(c.real) },
          caption,
        );
      } catch (err) {
        return textResult(
          `Could not send the file: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
      return textResult(`Sent ${basename(c.real)} (${size} bytes).`);
    },
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );
}

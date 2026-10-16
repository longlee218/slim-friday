import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { writeSpaceFile } from "../../../../discord-setup/write-space-file";
import { logger } from "../../../../observability/logger";
import { errText } from "../../../../observability/redact";
import { textResult } from "../../../tool-result";
import type { DiscordAdminContext } from "../../discord-admin-context";
import { WRITE_SPACE_FILE_TOOL } from "./constants";
import { WRITE_SPACE_FILE_DESCRIPTION } from "./prompt";

const log = logger.child({ module: "write-space-file-tool" });

/** The `WriteSpaceFile` tool: schema + error wrapper around `writeSpaceFile` (all checks live there). */
export function createWriteSpaceFileTool(ctx: DiscordAdminContext) {
  return tool(
    WRITE_SPACE_FILE_TOOL,
    WRITE_SPACE_FILE_DESCRIPTION,
    {
      space: z.string().describe("Space name."),
      channel: z.string().optional().describe("Channel name; omit to write the space's own file."),
      file: z.string().describe("File name, e.g. SOUL.md."),
      content: z.string().describe("The whole new content of the file."),
    },
    async (args) => {
      try {
        const r = await writeSpaceFile(ctx, args);
        return textResult(r.text, r.error);
      } catch (err) {
        log.warn({ err: errText(err) }, "write space file failed");
        return textResult("write failed (see logs)", true);
      }
    },
  );
}

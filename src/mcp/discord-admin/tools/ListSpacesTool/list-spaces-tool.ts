import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { logEvent, logger } from "../../../../observability/logger";
import { errText } from "../../../../observability/redact";
import { listSpaces } from "../../../../workspaces/list-spaces";
import { textResult } from "../../../tool-result";
import type { DiscordAdminContext } from "../../discord-admin-context";
import { LIST_SPACES_TOOL } from "./constants";
import { LIST_SPACES_DESCRIPTION } from "./prompt";

const log = logger.child({ module: "list-spaces-tool" });

/** The `ListSpaces` tool (read-only). */
export function createListSpacesTool(ctx: DiscordAdminContext) {
  return tool(
    LIST_SPACES_TOOL,
    LIST_SPACES_DESCRIPTION,
    { kind: z.string().optional().describe("Space kind whose template text to include.") },
    async ({ kind }) => {
      try {
        logEvent(log, "space.listed", { kind: kind ?? null });
        return textResult(listSpaces(ctx.home, kind));
      } catch (err) {
        log.warn({ err: errText(err) }, "list spaces failed");
        return textResult("could not list spaces", true);
      }
    },
  );
}

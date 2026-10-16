import { existsSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { LIST_SPACES_TOOL } from "../../mcp/mcp-tool-names";
import { SPACE_KIND_FILES, spaceKindFile, spaceKinds } from "../../memory/persona-templates";
import { logEvent, logger } from "../../observability/logger";
import { errText } from "../../observability/redact";
import { loadWorkspaces } from "../../workspaces/workspace-registry";
import type { DiscordAdminContext } from "../discord-admin-context";
import { SPACE_FILES } from "../WriteSpaceFileTool/constants";
import { LIST_SPACES_DESCRIPTION } from "./prompt";

const log = logger.child({ module: "list-spaces-tool" });

/**
 * The facts `ListSpaces` returns, as JSON text: spaces with channels, location names and the persona files that exist
 * in the space folder, the kinds, and (for a known `kind`) the template files. No path, id or secret is included.
 */
export function listSpaces(home: string, kind?: string): string {
  const scan = loadWorkspaces(home);
  const spaces = scan.workspaces.map((w) => ({
    name: w.name,
    channels: w.channelDefs.map((c) => ({ name: c.name, mode: c.mode })),
    locations: w.locations.map((l) => l.name),
    files: SPACE_FILES.filter((f) => existsSync(join(w.root, f))),
  }));
  const template = kind
    ? Object.fromEntries(SPACE_KIND_FILES.map((f) => [f, spaceKindFile(kind, f)]))
    : undefined;
  return JSON.stringify({
    spaces,
    kinds: spaceKinds(),
    ...(template && { kind, template }),
  });
}

/** The `ListSpaces` tool (read-only). */
export function createListSpacesTool(ctx: DiscordAdminContext) {
  return tool(
    LIST_SPACES_TOOL,
    LIST_SPACES_DESCRIPTION,
    { kind: z.string().optional().describe("Space kind whose template text to include.") },
    async ({ kind }) => {
      try {
        logEvent(log, "space.listed", { kind: kind ?? null });
        return { content: [{ type: "text" as const, text: listSpaces(ctx.home, kind) }] };
      } catch (err) {
        log.warn({ err: errText(err) }, "list spaces failed");
        return {
          content: [{ type: "text" as const, text: "could not list spaces" }],
          isError: true,
        };
      }
    },
  );
}

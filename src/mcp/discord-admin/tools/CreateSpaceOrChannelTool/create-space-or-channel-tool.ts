import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { parseAdminCommand } from "../../../../discord-setup/admin-command";
import { initChannel } from "../../../../discord-setup/init-channel";
import { initWorkspace } from "../../../../discord-setup/init-workspace";
import { logEvent, logger } from "../../../../observability/logger";
import { errText } from "../../../../observability/redact";
import type { DiscordAdminContext } from "../../discord-admin-context";
import { CREATE_SPACE_OR_CHANNEL_TOOL } from "./constants";
import { CREATE_SPACE_OR_CHANNEL_DESCRIPTION } from "./prompt";

const log = logger.child({ module: "create-space-or-channel-tool" });

/**
 * Create a space or a channel through the same code as the `/init-workspace` and `/init-channel` commands: the names go
 * through the command parser first (same format, reserved-name and length rules), then `initWorkspace` / `initChannel`
 * (create-only, private overwrites, same refusals), after the owner confirmed. Returns `{ text, error }`; the text is the command's own reply.
 */
async function createSpaceOrChannel(
  ctx: DiscordAdminContext,
  space: string,
  channel?: string,
): Promise<{ text: string; error: boolean }> {
  const cmd = parseAdminCommand(
    channel === undefined ? `/init-workspace ${space}` : `/init-channel ${space}/${channel}`,
  );
  if (cmd.kind === "invalid_name" || cmd.kind === "help") return { text: cmd.reply, error: true };
  // The owner confirms with buttons first; a no, a timeout or an error creates nothing (fails closed).
  const label = cmd.kind === "init_channel" ? `${cmd.space}/${cmd.name}` : cmd.name;
  const yes = await ctx
    .confirm({
      kind: "create_space_or_channel",
      summary: `Create ${cmd.kind === "init_channel" ? "channel" : "space"} ${label}`,
    })
    .catch((err: unknown) => {
      log.warn({ err: errText(err) }, "create confirm failed");
      return false;
    });
  if (!yes) return { text: "not created: the owner declined or did not answer", error: false };
  const text =
    cmd.kind === "init_channel"
      ? await initChannel(ctx.init, cmd.space, cmd.name)
      : await initWorkspace(ctx.init, cmd.name);
  logEvent(log, "space.created", { kind: cmd.kind });
  return { text, error: false };
}

/** The `CreateSpaceOrChannel` tool. No delete or rename tool exists. */
export function createCreateSpaceOrChannelTool(ctx: DiscordAdminContext) {
  return tool(
    CREATE_SPACE_OR_CHANNEL_TOOL,
    CREATE_SPACE_OR_CHANNEL_DESCRIPTION,
    {
      space: z.string().describe("Space name (category + folder)."),
      channel: z
        .string()
        .optional()
        .describe("Channel name to add to the space; omit to create the space."),
    },
    async ({ space, channel }) => {
      try {
        const r = await createSpaceOrChannel(ctx, space, channel);
        return {
          content: [{ type: "text" as const, text: r.text }],
          ...(r.error && { isError: true }),
        };
      } catch (err) {
        log.warn({ err: errText(err) }, "create space or channel failed");
        return {
          content: [{ type: "text" as const, text: "creation failed (see logs)" }],
          isError: true,
        };
      }
    },
  );
}

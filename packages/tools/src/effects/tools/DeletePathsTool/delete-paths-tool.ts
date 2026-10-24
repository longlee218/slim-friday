import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { withEffectRecord } from "../../effect-call-guard";
import type { EffectsContext } from "../../effects-context";
import { moveToTrash } from "../../trash-store";
import { checkInsideWorkspace, protectedInside } from "../../workspace-paths";
import { DELETE_PATHS_MAX, DELETE_PATHS_TOOL } from "./constants";
import { DELETE_PATHS_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  paths: z.array(z.string().min(1)).min(1).max(DELETE_PATHS_MAX).describe("Absolute paths."),
  reason: z.string().min(1).max(500).describe("Why they go."),
};

/** `DeletePaths` for one session: every path is checked first; one refusal moves nothing. */
export function createDeletePathsTool(ctx: EffectsContext) {
  return tool(
    DELETE_PATHS_TOOL,
    DELETE_PATHS_DESCRIPTION,
    SHAPE,
    async (input) => {
      const { paths } = input;
      const reals: string[] = [];
      for (const p of new Set(paths)) {
        const c = checkInsideWorkspace(p, ctx.workspaces, ctx.isSensitive);
        if (typeof c === "string") return textResult(`Refused, nothing deleted: ${c}`, true);
        // A dir goes whole: what it holds gets the same protection as the dir itself.
        const inside = protectedInside(c.real, ctx.isSensitive);
        if (inside) return textResult(`Refused, nothing deleted: ${inside}`, true);
        reals.push(c.real);
      }
      // Each path is checked again right before it moves: a link swapped in meanwhile stops the move.
      // Recorded: a run executed again after a cut does not move the paths twice.
      return withEffectRecord(ctx.record, DELETE_PATHS_TOOL, input, async () => {
        const move = moveToTrash(ctx.home, ctx.botId, reals, Date.now(), (from) => {
          const c = checkInsideWorkspace(from, ctx.workspaces, ctx.isSensitive);
          return typeof c !== "string" && c.real === from;
        });
        if (move.error)
          return textResult(
            `Stopped (${move.error}) after ${move.entries.length} of ${reals.length}; moved ones are in ${move.dir}`,
            true,
          );
        return textResult(`Moved ${reals.length} path(s) to ${move.dir} (kept 7 days).`);
      });
    },
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  );
}

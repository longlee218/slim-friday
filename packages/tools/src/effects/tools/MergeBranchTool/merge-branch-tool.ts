import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { EffectsContext } from "../../effects-context";
import { badName, grantedWorkspace, isPlainName, NOT_GRANTED } from "../../git-args";
import { MERGE_BRANCH_TOOL } from "./constants";
import { MERGE_BRANCH_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  workspace: z.string().min(1).describe("Absolute path of one of your workspaces."),
  from: z.string().min(1).describe("Branch to merge."),
  into: z.string().min(1).describe("Branch that receives the merge."),
};

/** `MergeBranch` for one session. */
export function createMergeBranchTool(ctx: EffectsContext) {
  return tool(
    MERGE_BRANCH_TOOL,
    MERGE_BRANCH_DESCRIPTION,
    SHAPE,
    async ({ workspace, from, into }) => {
      if (!isPlainName(from)) return textResult(badName("from"), true);
      if (!isPlainName(into)) return textResult(badName("into"), true);
      const cwd = grantedWorkspace(ctx, workspace);
      if (!cwd) return textResult(NOT_GRANTED, true);
      const status = await ctx.run(["git", "status", "--porcelain"], cwd);
      if (status.code !== 0) return textResult(status.out.trim() || "git status failed", true);
      if (status.out.trim())
        return textResult("Refused: the worktree has uncommitted changes.", true);
      const checkout = await ctx.run(["git", "checkout", into], cwd);
      if (checkout.code !== 0) return textResult(checkout.out.trim(), true);
      const merge = await ctx.run(["git", "merge", "--no-ff", "--no-edit", from], cwd);
      if (merge.code === 0) return textResult(merge.out.trim() || "merged");
      // Leave the repo as it was before the merge, never half merged.
      await ctx.run(["git", "merge", "--abort"], cwd);
      return textResult(`Merge conflict, aborted; nothing changed.\n${merge.out.trim()}`, true);
    },
    {
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
  );
}

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { EffectsContext } from "../../effects-context";
import { badName, grantedWorkspace, isPlainName, NOT_GRANTED, runGit } from "../../git-args";
import { MERGE_BRANCH_TOOL } from "./constants";
import { MERGE_BRANCH_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  workspace: z.string().min(1).describe("Absolute path of one of your workspaces."),
  from: z.string().min(1).describe("Branch to merge."),
  into: z.string().min(1).describe("Branch that receives the merge."),
};

/** `MergeBranch` for one session: merges, then goes back to the branch the bot was on. */
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
      const git = (...args: string[]) => runGit(ctx, cwd, args);
      const status = await git("status", "--porcelain");
      if (typeof status === "string") return textResult(status, true);
      if (status.code !== 0) return textResult(status.out.trim() || "git status failed", true);
      if (status.out.trim())
        return textResult("Refused: the worktree has uncommitted changes.", true);
      const head = await git("rev-parse", "--abbrev-ref", "HEAD");
      if (typeof head === "string" || head.code !== 0)
        return textResult("Refused: cannot read the current branch.", true);
      const back = head.out.trim();
      const checkout = await git("checkout", into);
      if (typeof checkout === "string" || checkout.code !== 0)
        return textResult(typeof checkout === "string" ? checkout : checkout.out.trim(), true);
      const merge = await git("merge", "--no-ff", "--no-edit", from);
      const ok = typeof merge !== "string" && merge.code === 0;
      // Leave the repo as it was before the merge, never half merged, and on the bot's own branch.
      if (!ok) await git("merge", "--abort");
      if (back !== into) await git("checkout", back);
      const out = typeof merge === "string" ? merge : merge.out.trim();
      return ok
        ? textResult(out || "merged")
        : textResult(`Merge conflict, aborted; nothing changed.\n${out}`, true);
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

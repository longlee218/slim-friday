import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import type { EffectsContext } from "../../effects-context";
import { badName, grantedWorkspace, isPlainName, NOT_GRANTED, runGit } from "../../git-args";
import { GIT_PUSH_TOOL } from "./constants";
import { GIT_PUSH_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  workspace: z.string().min(1).describe("Absolute path of one of your workspaces."),
  remote: z.string().min(1).describe("Remote name, e.g. origin."),
  branch: z.string().min(1).describe("Branch to push (same name on the remote)."),
};

/** `GitPush` for one session. */
export function createGitPushTool(ctx: EffectsContext) {
  return tool(
    GIT_PUSH_TOOL,
    GIT_PUSH_DESCRIPTION,
    SHAPE,
    async ({ workspace, remote, branch }) => {
      if (!isPlainName(remote)) return textResult(badName("remote"), true);
      if (!isPlainName(branch)) return textResult(badName("branch"), true);
      const cwd = grantedWorkspace(ctx, workspace);
      if (!cwd) return textResult(NOT_GRANTED, true);
      const r = await runGit(ctx, cwd, ["push", remote, `${branch}:${branch}`]);
      if (typeof r === "string") return textResult(r, true);
      return textResult(r.out.trim() || (r.code === 0 ? "pushed" : "push failed"), r.code !== 0);
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  );
}

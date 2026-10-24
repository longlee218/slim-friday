import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { textResult } from "../../../tool-result";
import { withEffectRecord } from "../../effect-call-guard";
import type { EffectsContext } from "../../effects-context";
import {
  badName,
  GIT_RUN_ENV,
  grantedWorkspace,
  isPlainName,
  NOT_GRANTED,
  runGit,
} from "../../git-args";
import { CREATE_PULL_REQUEST_TOOL, PR_BODY_MAX, PR_TITLE_MAX } from "./constants";
import { CREATE_PULL_REQUEST_DESCRIPTION } from "./prompt";

/** Input the model sees. */
const SHAPE = {
  workspace: z.string().min(1).describe("Absolute path of one of your workspaces."),
  base: z.string().min(1).describe("Branch to merge into."),
  head: z.string().min(1).describe("Branch with the changes (already pushed)."),
  title: z.string().min(1).max(PR_TITLE_MAX),
  body: z.string().max(PR_BODY_MAX),
};

/** `CreatePullRequest` for one session. */
export function createCreatePullRequestTool(ctx: EffectsContext) {
  return tool(
    CREATE_PULL_REQUEST_TOOL,
    CREATE_PULL_REQUEST_DESCRIPTION,
    SHAPE,
    async (input) => {
      const { workspace, base, head, title, body } = input;
      if (!isPlainName(base)) return textResult(badName("base"), true);
      if (!isPlainName(head)) return textResult(badName("head"), true);
      const cwd = grantedWorkspace(ctx, workspace);
      if (!cwd) return textResult(NOT_GRANTED, true);
      // gh runs git in the repo too: the same config check first (a no-op git call carries it).
      const check = await runGit(ctx, cwd, ["--version"]);
      if (typeof check === "string") return textResult(check, true);
      // Recorded: a run executed again after a cut does not open a second pull request.
      return withEffectRecord(ctx.record, CREATE_PULL_REQUEST_TOOL, input, async () => {
        // argv, no shell: the title and body are single arguments whatever they contain.
        const r = await ctx.run(
          ["gh", "pr", "create", "--base", base, "--head", head, "--title", title, "--body", body],
          cwd,
          GIT_RUN_ENV,
        );
        return textResult(r.out.trim() || "gh gave no output", r.code !== 0);
      });
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  );
}

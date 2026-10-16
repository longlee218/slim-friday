import { ghDenial } from "../../guardrails/gh-policy";
import { CREATE_PULL_REQUEST_TOOL } from "../../mcp/effects/tools/CreatePullRequestTool/constants";
import { type Reply, refuse } from "../engine/lead-call";
import { checkEnvelope, isFallbackDefault } from "./check-envelope";
import { type EffectsCtx, locationPath, recordEffect, refuseLogged } from "./effect-context";
import { isPlainRef } from "./git-run";

/* CreatePullRequest: `gh pr create` as an argv array. The head is a feature branch the grant covers. */

/** Handle one `CreatePullRequest` call. */
export async function createPullRequest(
  ctx: EffectsCtx,
  input: { location: string; base: string; head: string; title: string; body: string },
): Promise<Reply> {
  const { location, base, head, title, body } = input;
  const scope = `${location} ${base}<-${head}`;
  const refused = (code: string, message: string) =>
    refuseLogged(ctx, CREATE_PULL_REQUEST_TOOL, scope, code, message);
  if (!isPlainRef(base) || !isPlainRef(head) || isFallbackDefault(head))
    return refused(
      "BAD_REF",
      "Base and head must be plain branch names; the head is not a default branch.",
    );
  const verdict = checkEnvelope(
    { tool: CREATE_PULL_REQUEST_TOOL, location, branch: head },
    ctx.envelope,
  );
  if (!verdict.allow) return refused(verdict.code, verdict.reason);
  const cwd = locationPath(ctx, location);
  if (!cwd) return refused("OUT_OF_ENVELOPE", "Unknown location.");
  const argv = [
    "gh",
    "pr",
    "create",
    "--base",
    base,
    "--head",
    head,
    "--title",
    title,
    "--body",
    body,
  ];
  const denied = ghDenial(argv.slice(1));
  if (denied) return refused("DENIED", denied);
  const r = await ctx.run(argv, cwd);
  recordEffect(ctx, {
    tool: CREATE_PULL_REQUEST_TOOL,
    scope,
    result: JSON.stringify({ code: r.code, out: r.out }),
    undo: "close the pull request: gh pr close <number>",
  });
  return r.code === 0
    ? { ok: true, url: r.out }
    : refuse("PR_FAILED", `gh pr create failed: ${r.out}`);
}

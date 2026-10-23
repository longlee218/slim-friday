import { isPlainRef } from "../locations/git-run";
import { CREATE_PULL_REQUEST_TOOL } from "../mcp/effects/tools/CreatePullRequestTool/constants";
import { checkEnvelope, isFallbackDefault } from "../policy/check-envelope";
import {
  askOwnerPerAct,
  type EffectsCtx,
  locationPath,
  recordEffect,
  refuseLogged,
  safeText,
} from "../policy/effect-context";
import { type Reply, refuse } from "./reply";

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
  const asked = await askOwnerPerAct(ctx, {
    tool: CREATE_PULL_REQUEST_TOOL,
    scope,
    summary: `Create a pull request ${safeText(head)} into ${safeText(base)} in ${safeText(location)}?\nTitle: ${safeText(title)}`,
  });
  if (asked) return asked;
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
  const r = await ctx.run(argv, cwd);
  recordEffect(ctx, {
    tool: CREATE_PULL_REQUEST_TOOL,
    scope,
    result: JSON.stringify({ code: r.code, out: r.out }),
    undo: "close the pull request: gh pr close <number>",
    owner: ctx.ownerPerAct,
  });
  return r.code === 0
    ? { ok: true, url: r.out }
    : refuse("PR_FAILED", `gh pr create failed: ${r.out}`);
}

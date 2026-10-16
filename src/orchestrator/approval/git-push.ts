import { GIT_PUSH_TOOL } from "../../mcp/effects/tools/GitPushTool/constants";
import { type Reply, refuse } from "../engine/lead-call";
import { checkEnvelope, grantNamesBranch, isFallbackDefault } from "./check-envelope";
import {
  type EffectsCtx,
  locationPath,
  recordEffect,
  refuseLogged,
  safeText,
} from "./effect-context";
import { isPlainRef } from "./git-run";
import { checkRemote } from "./remote-pin";

/* GitPush: push one local branch, never forced. Inside the grant a feature branch runs; a default branch is R4 (asks at every
   act, grant or not). The remote's URL must be a plain network URL and stay the one first used for the goal. */

/** The remote's own default branch (`git ls-remote --symref <remote> HEAD`), or undefined when it cannot be read. */
async function remoteDefault(
  ctx: EffectsCtx,
  cwd: string,
  remote: string,
): Promise<string | undefined> {
  const r = await ctx.run(["git", "ls-remote", "--symref", remote, "HEAD"], cwd);
  return r.code === 0 ? /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(r.out)?.[1] : undefined;
}

/** Handle one `GitPush` call. */
export async function gitPush(
  ctx: EffectsCtx,
  input: { location: string; remote: string; branch: string },
): Promise<Reply> {
  const { location, remote, branch } = input;
  const scope = `${location} ${remote} ${branch}`;
  const refused = (code: string, message: string, result?: "denied") =>
    refuseLogged(ctx, GIT_PUSH_TOOL, scope, code, message, result);
  if (!isPlainRef(remote) || !isPlainRef(branch))
    return refused(
      "BAD_REF",
      "Remote and branch must be plain names (no leading dash, no force refspec).",
    );
  const verdict = checkEnvelope({ tool: GIT_PUSH_TOOL, location, branch }, ctx.envelope);
  if (!verdict.allow && verdict.code !== "R4") return refused(verdict.code, verdict.reason);
  const cwd = locationPath(ctx, location);
  if (!cwd) return refused("OUT_OF_ENVELOPE", "Unknown location.");
  const remotes = await ctx.run(["git", "remote"], cwd);
  if (remotes.code !== 0 || !remotes.out.split("\n").includes(remote))
    return refused("BAD_REF", "That remote does not exist in the location.");
  const pin = await checkRemote(ctx, cwd, location, remote);
  if (!pin.ok) return refused(pin.code, pin.message);
  const local = await ctx.run(["git", "rev-parse", "--verify", `refs/heads/${branch}`], cwd);
  if (local.code !== 0) return refused("BAD_REF", "That local branch does not exist.");
  // R4: the remote's default branch asks the owner at EVERY act, even inside a grant. The usual names (main, master,
  // develop, trunk, release*) count as default too. When the remote's default cannot be read, only a branch the grant names
  // exactly runs without asking (fail closed: an unreadable remote never lowers the bar).
  const def = isFallbackDefault(branch) ? branch : await remoteDefault(ctx, cwd, remote);
  const isDefault =
    def === undefined
      ? !grantNamesBranch(ctx.envelope, GIT_PUSH_TOOL, location, branch)
      : def === branch;
  if (isDefault) {
    const yes = await ctx.confirm(
      `Push to the default branch ${safeText(branch)} of ${safeText(location)}?`,
    );
    if (!yes)
      return refused(
        "OWNER_DENIED",
        "The owner did not allow a push to a default branch.",
        "denied",
      );
  }
  const r = await ctx.run(
    ["git", "push", "--", remote, `refs/heads/${branch}:refs/heads/${branch}`],
    cwd,
  );
  recordEffect(ctx, {
    tool: GIT_PUSH_TOOL,
    scope,
    result: JSON.stringify({ code: r.code, out: r.out }),
    undo: `delete the remote branch: git push ${remote} --delete ${branch}`,
    owner: isDefault,
  });
  return r.code === 0
    ? { ok: true, pushed: branch }
    : refuse("PUSH_FAILED", `git push failed: ${r.out}`);
}

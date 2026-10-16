import { createHash } from "node:crypto";
import type { EffectsCtx } from "../../orchestrator/approval/effect-context";
import { appendEffect } from "../../storage/effect-log-store";

/* The remote a goal pushes to is pinned: its (push) URL must be a plain network URL and, once recorded for the goal, must not
   change. A worker that rewrites `remote.<name>.url` (it cannot through the shell, but a script can) is refused at the next push. */

/** Row id and tool of the pin in `effect_log`. */
const REMOTE_PIN_TOOL = "RemotePin";
const pinId = (ctx: EffectsCtx, location: string, remote: string): string =>
  `remote:${ctx.goalId}:${location}:${remote}`;

/** Only https, ssh and scp-like (`git@host:path`) remotes: `ext::` runs a command, `file:` and paths reach the local disk. */
const NETWORK_URL = /^(https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/i;

/** What `checkRemote` found: ok, or the refusal code + message. */
export type RemoteCheck = { ok: true } | { ok: false; code: string; message: string };

/**
 * Read the push URL of `remote` (`git remote get-url --push`) and judge it: a plain network URL (else BAD_REMOTE), and the
 * same as the one pinned for this goal (else REMOTE_CHANGED). The first push of a goal pins it. The audit row keeps a hash,
 * never the URL (it may hold credentials).
 */
export async function checkRemote(
  ctx: EffectsCtx,
  cwd: string,
  location: string,
  remote: string,
): Promise<RemoteCheck> {
  const r = await ctx.run(["git", "remote", "get-url", "--push", remote], cwd);
  const url = r.out.trim();
  if (r.code !== 0 || !NETWORK_URL.test(url))
    return {
      ok: false,
      code: "BAD_REMOTE",
      message: "That remote's URL is not a plain https or ssh URL.",
    };
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
  const id = pinId(ctx, location, remote);
  const row = ctx.db
    .query<{ scope: string }, [string]>("SELECT scope FROM effect_log WHERE id = ?")
    .get(id);
  if (row && row.scope !== hash)
    return {
      ok: false,
      code: "REMOTE_CHANGED",
      message: "The remote's URL changed since it was first used for this goal.",
    };
  if (!row)
    appendEffect(ctx.db, {
      id,
      threadId: ctx.threadId,
      goalId: ctx.goalId,
      itemId: ctx.itemId,
      tool: REMOTE_PIN_TOOL,
      scope: hash,
      grantedBy: ctx.envelope.grantedBy,
      result: "pinned",
    });
  return { ok: true };
}

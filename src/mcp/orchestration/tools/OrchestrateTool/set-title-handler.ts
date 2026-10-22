import { applyThreadTitle } from "../../../../ingress/thread-rename";
import { type Reply, refuse } from "../../../../orchestrator/reply";
import { SET_TITLE_MAX_CALLS_PER_RUN } from "./constants";
import type { OrchestrateCtx } from "./orchestrate-ctx";

/**
 * `set_title`: always stores title + digest; renames the thread only while its live name is still the bot's
 * placeholder (adopted threads have none). At most `SET_TITLE_MAX_CALLS_PER_RUN` calls per run.
 */
export async function handleSetTitle(
  c: OrchestrateCtx,
  args: { title: string; digest: string },
): Promise<Reply> {
  const ctx = c.memory;
  if (!ctx?.threadId || !ctx.threadTitle)
    return refuse("NO_THREAD", "This run has no thread: skip it.");
  if (++c.titleCalls.n > SET_TITLE_MAX_CALLS_PER_RUN)
    return refuse("LIMIT", `At most ${SET_TITLE_MAX_CALLS_PER_RUN} calls per run: skip it.`);
  const result = await applyThreadTitle(
    {
      db: ctx.db,
      threadId: ctx.threadId,
      channelId: ctx.channelId,
      workspace: ctx.workspace,
      port: ctx.threadTitle,
      now: ctx.now,
    },
    args.title,
    args.digest,
  );
  if (result === "empty") return refuse("EMPTY", "Title and digest must not be empty: skip it.");
  return {
    ok: true,
    note:
      result === "renamed"
        ? "saved; thread renamed"
        : result === "kept"
          ? "saved; thread name kept"
          : "saved; rename failed",
  };
}

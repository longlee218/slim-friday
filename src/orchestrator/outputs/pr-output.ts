import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../../approvals/approval-types";
import { hasAttribution } from "../../guardrails/check-tool-call";
import type { GitData, GitIdentity, GitMcp } from "../../mcp/git-mcp";
import { createPullRequest } from "../../mcp/github-mcp";
import { GIT_TOOL } from "../../mcp/mcp-tool-names";
import { logEvent, logger } from "../../observability/logger";
import { clip, errText, redactText } from "../../observability/redact";
import { recordFilesChanged } from "../../storage/files-changed";
import {
  setDelivered,
  setPrUrl,
  setWorktreeStatus,
  type WorktreeRow,
} from "../../storage/worktree-store";
import { deliveryFor } from "../../workspaces/task-clone";
import { CREATE_PR_APPROVAL } from "../engine/gates";
import { finishLocalResult } from "./local-result-output";
import { mayPublish, originSlug, pushBranch } from "./pr-publish";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "pr-output" });

/** A commit of the branch as the app sees it (git_log author + git_show text). */
interface BranchCommit {
  authorEmail: string;
  /** Full `git_show` text: header, message and diff. */
  shown: string;
}

/** Problems that forbid publishing: wrong author or attribution lines. Empty = fine. */
function commitProblems(commits: BranchCommit[], a: GitIdentity): string[] {
  const problems = new Set<string>();
  for (const c of commits) {
    if (c.authorEmail.toLowerCase() !== a.email.toLowerCase()) {
      problems.add(`commit by <${c.authorEmail}> (expected ${a.email})`);
    }
    // Only the message part (before the diff) is scanned: code may legitimately mention these words.
    if (hasAttribution(c.shown.split(/\ndiff --git /)[0] ?? "")) {
      problems.add("commit message has an attribution/co-author line");
    }
  }
  return [...problems];
}

/** Cap of the diff attached to the PR offer. */
const DIFF_CAP = 200_000;

/** Short PR title from the owner's task text (first line, capped). */
export function prTitle(text: string): string {
  return clip(text.trim().split("\n")[0] ?? "", 70) || "Agent change";
}

/** Commits ahead of the base branch (origin/<base>, else local <base>) as git_log reports them. */
async function commitsAhead(
  git: GitMcp,
  path: string,
  base: string,
): Promise<{ ref: string; log: GitData }> {
  let last: unknown;
  for (const ref of [`origin/${base}`, base]) {
    try {
      return {
        ref,
        log: await git.call(GIT_TOOL.LOG, { path, branch: `${ref}..HEAD`, maxCount: 100 }),
      };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * After an execute run: summarize the worktree and, when there are commits, ask the owner
 * whether to push + open the PR. Returns the reply text (agent summary + PR link or status).
 */
export async function finishCodeTask(
  deps: {
    db: Database;
    approvals: ApprovalGateway;
    git: GitMcp;
    /** Agent home: where the local result patch is written. */
    agentHome: string;
    /** Thread lock check for the Keep/Discard click of a local result (see `LocalResultDeps`). */
    threadBusy?: (threadId: string) => boolean;
    /** PR creator; injectable in tests. */
    createPr?: typeof createPullRequest;
  },
  o: {
    wt: WorktreeRow;
    taskId: string;
    threadId: string;
    title: string;
    body: string;
    text: string;
    /** Task abort signal: `stop` during the PR step must cancel the offer and the push. */
    signal: AbortSignal;
    /** Commit identity the branch must carry (author + committer) with no attribution lines. */
    author: GitIdentity;
    /** GitHub login whose token creates the PR (active gh account when omitted). */
    githubAccount?: string;
  },
): Promise<string> {
  const { wt } = o;
  // A clone whose owner repo has no GitHub origin is delivered as a local result (branch + fetch command + patch).
  if (wt.baseSha !== null && deliveryFor(wt.originUrl) !== "pr")
    return finishLocalResult(
      {
        db: deps.db,
        approvals: deps.approvals,
        agentHome: deps.agentHome,
        threadBusy: deps.threadBusy,
      },
      { wt, taskId: o.taskId, threadId: o.threadId, text: o.text },
    );
  /** A failed publish: logged as pr.failed, returned as the reply tail. */
  const prFailed = (why: string): string => {
    // A git error can echo the remote url: both the log and the owner reply get the redacted text.
    logEvent(log, "pr.failed", { repo: wt.repo, branch: wt.branch, reason: errText(why) }, "warn");
    return `${o.text}\n\nPR failed: ${errText(why)}`;
  };
  const { git } = deps;
  const { ref, log: ahead } = await commitsAhead(git, wt.path, wt.base);
  const commits = (ahead.commits ?? []) as { hash: string; authorEmail: string }[];
  const status = await git.call(GIT_TOOL.STATUS, { path: wt.path });
  // The reviewed diff is HEAD's; the push sends wt.branch. They must be the same branch.
  if (status.currentBranch !== wt.branch) {
    return `${o.text}\n\nThe clone is on "${status.currentBranch}", not ${wt.branch}: no PR offered.`;
  }
  const dirty = status.isClean === false ? "\nUncommitted changes remain in the clone." : "";
  if (commits.length === 0) return `${o.text}\n\nNo commits on ${wt.branch}.${dirty}`;
  const range = { path: wt.path, source: ref, target: "HEAD" };
  const stat = String((await git.call(GIT_TOOL.DIFF, { ...range, stat: true })).diff ?? "").trim();
  recordFilesChanged(deps.db, wt.taskId, stat); // ledger: files changed
  const fullDiff = String((await git.call(GIT_TOOL.DIFF, range)).diff ?? "");
  // Pushed commits carry raw content while the owner sees a redacted diff: never push a possible secret.
  // The scan covers the WHOLE diff; the cap below only limits what is shown.
  if (redactText(fullDiff) !== fullDiff) {
    return `${o.text}\n\nPossible secret in the diff of ${wt.branch}: PR not offered. Remove it and commit again.`;
  }
  const diff = fullDiff.slice(0, DIFF_CAP);
  const shown = await Promise.all(
    commits.map(async (c) => ({
      authorEmail: c.authorEmail,
      shown: String(
        (await git.call(GIT_TOOL.SHOW, { path: wt.path, object: c.hash })).content ?? "",
      ),
    })),
  );
  const problems = commitProblems(shown, o.author);
  if (problems.length > 0) return `${o.text}\n\nPR not offered: ${problems.join("; ")}.`;
  const truncated = diff.length >= DIFF_CAP - 1000 ? "\n(diff truncated in the attachment)" : "";

  const ok = await deps.approvals.confirm(
    {
      taskId: o.taskId,
      threadId: o.threadId,
      tool: CREATE_PR_APPROVAL,
      summary: `Create PR for ${wt.repo}?\n${wt.branch} -> ${wt.base}: ${commits.length} commit(s)\n${stat}${dirty}${truncated}`,
      detail: diff,
    },
    ["Create PR", "Not now"],
  );
  if (!ok.approved) {
    setWorktreeStatus(deps.db, wt.taskId, "kept"); // not published: the owner still holds the clone
    return `${o.text}\n\nBranch ${wt.branch} is ready, not pushed. Reply in this thread to continue; the PR is offered again after the next changes.`;
  }
  if (o.signal.aborted) return `${o.text}\n\nStopped before pushing.`;
  // Push the task branch (never forced; `friday/*` from a clone), then open the PR through the GitHub MCP server.
  if (!mayPublish(wt)) return prFailed("refusing to publish non-agent branch.");
  try {
    await pushBranch(git, wt);
  } catch (err) {
    return prFailed(err instanceof Error ? err.message : String(err));
  }
  logEvent(log, "push", { repo: wt.repo, branch: wt.branch });
  const slug = await originSlug(git, wt);
  if (!slug) return prFailed("cannot parse origin remote as a GitHub repo");
  const r = await (deps.createPr ?? createPullRequest)({
    account: o.githubAccount,
    ...slug,
    head: wt.branch,
    base: wt.base,
    title: o.title,
    body: `${redactText(o.body).slice(0, 5000)}\n\nCreated by the Friday agent.`,
  });
  if (!r.ok) return prFailed(r.error);
  setPrUrl(deps.db, wt.taskId, r.url);
  setDelivered(deps.db, wt.taskId, "pr", null);
  logEvent(log, "pr.created", { repo: wt.repo, branch: wt.branch, url: r.url });
  return `${o.text}\n\nPR: ${r.url}`;
}

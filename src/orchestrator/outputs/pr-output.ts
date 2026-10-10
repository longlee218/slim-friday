import type { Database } from "bun:sqlite";
import type { ApprovalGateway } from "../../approvals/approval-types";
import { hasAttribution } from "../../guardrails/check-tool-call";
import type { GitData, GitIdentity, GitMcp } from "../../mcp/git-mcp";
import { createPullRequest, parseRemote } from "../../mcp/github-mcp";
import { GIT_TOOL } from "../../mcp/mcp-tool-names";
import { logEvent, logger } from "../../observability/logger";
import { clip, errText, redactText } from "../../observability/redact";
import { setPrUrl, type WorktreeRow } from "../../storage/worktree-store";
import { CREATE_PR_APPROVAL } from "../engine/gates";

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

/** Reply for a managed clone while PR delivery for clones is missing. */
const CLONE_PR_PENDING = (wt: WorktreeRow): string =>
  `PR delivery for task clones arrives with P2.2. Branch ${wt.branch} stays in the clone at ${wt.path}.`;

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
  // REMOVABLE SEAM (P2.2): a managed clone (base_sha set) has no origin and a `friday/*` branch, so the
  // push below would fail after the owner approved. Remove this line when P2.2 adds clone delivery.
  if (wt.baseSha !== null) return `${o.text}\n\n${CLONE_PR_PENDING(wt)}`;
  /** A failed publish: logged as pr.failed, returned as the reply tail. */
  const prFailed = (why: string): string => {
    logEvent(log, "pr.failed", { repo: wt.repo, branch: wt.branch, reason: errText(why) }, "warn");
    return `${o.text}\n\nPR failed: ${why}`;
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
  const diff = String((await git.call(GIT_TOOL.DIFF, range)).diff ?? "").slice(0, DIFF_CAP);
  // Pushed commits carry raw content while the owner sees a redacted diff: never push a possible secret.
  if (redactText(diff) !== diff) {
    return `${o.text}\n\nPossible secret in the diff of ${wt.branch}: PR not offered. Remove it and commit again.`;
  }
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
    return `${o.text}\n\nBranch ${wt.branch} is ready, not pushed. Reply in this thread to continue; the PR is offered again after the next changes.`;
  }
  if (o.signal.aborted) return `${o.text}\n\nStopped before pushing.`;
  // Push the agent branch (never forced; agent/* only), then open the PR through the GitHub MCP server.
  if (!wt.branch.startsWith("agent/")) return prFailed("refusing to publish non-agent branch.");
  try {
    await git.call(GIT_TOOL.PUSH, {
      path: wt.path,
      remote: "origin",
      branch: wt.branch,
      setUpstream: true,
    });
  } catch (err) {
    return prFailed(String(err instanceof Error ? err.message : err));
  }
  logEvent(log, "push", { repo: wt.repo, branch: wt.branch });
  const remotes: GitData = await git
    .call(GIT_TOOL.REMOTE, { path: wt.path, mode: "list" })
    .catch(() => ({}));
  const origin = (remotes.remotes as { name: string; fetchUrl?: string }[] | undefined)?.find(
    (x) => x.name === "origin",
  );
  const slug = parseRemote(origin?.fetchUrl ?? "");
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
  logEvent(log, "pr.created", { repo: wt.repo, branch: wt.branch, url: r.url });
  return `${o.text}\n\nPR: ${r.url}`;
}

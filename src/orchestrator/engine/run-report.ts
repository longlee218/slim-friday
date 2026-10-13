import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { logger, setLogContext, tryLog } from "../../observability/logger";
import type { Repo } from "../../repos/repo-registry";
import { RESUME_FAILED } from "../../runtime/run-errors";
import { setTurnRepo } from "../../storage/run-store";
import { type FlowResult, resumeReasonOf } from "../turns/turn-result";
import type { RoleRunInput } from "./role-run-types";

/* What the app reads from the END of a background run's report (`repo: <name>`) and how a failure is tagged. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-report" });

/** The last non-empty line of the form `repo: <name>` (optionally a bullet, bold or in backticks). */
const REPO_LINE = /^\s*[-*]?\s*\**repo\**\s*:\s*`?([\w.-]+)`?\s*$/i;

/**
 * Split the final report into text + the repo the agent named on its last non-empty line `repo: <name>`. The line is removed from the
 * text; the name counts only when it is one of `repos` (case-insensitive, returned as registered). No valid marker =
 * no repo (the ledger shows `*`).
 */
export function extractRepoMarker(text: string, repos: Repo[]): { text: string; repo?: Repo } {
  const lines = text.split("\n");
  // Only the LAST non-empty line can be the marker (a `repo:` line earlier in the report is just text).
  const at = lines.findLastIndex((l) => l.trim() !== "");
  if (at < 0 || !REPO_LINE.test(lines[at] ?? "")) return { text };
  const name = REPO_LINE.exec(lines[at] ?? "")?.[1]?.toLowerCase();
  const rest = [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n").trimEnd();
  return { text: rest, repo: repos.find((r) => r.name.toLowerCase() === name) };
}

/**
 * Close a background run. A failure that kept its session (budget, error) is tagged resumable: `/go` continues that
 * session. A success names its repo on the last `repo:` line (validated against the workspace repos): the turn row, the
 * log context follow it. No valid marker = no repo: the ledger shows `*`. A `Memory:` block in the report is plain text
 * (lessons are saved by the agent during the run with its memory tool).
 */
export function closeBackgroundRun(
  d: { db: Database; config: AgentConfig },
  i: RoleRunInput,
  res: FlowResult,
): FlowResult {
  if (res.outcome !== "success") {
    // A failed RESUME (the session transcript is gone) is never resumable: a `/go` would fail the same way.
    const resumeFailed = res.outcome === "error" && RESUME_FAILED.test(res.text);
    const reason = res.sessionId && !resumeFailed ? resumeReasonOf(res) : undefined;
    return reason ? { ...res, resumable: reason } : res;
  }
  const marked = extractRepoMarker(res.text, i.repos);
  const repo = marked.repo ?? i.repos.find((r) => r.name === res.repo);
  if (repo) {
    setLogContext({ repo: repo.name });
    tryLog(log, "set turn repo failed", () => setTurnRepo(d.db, i.turnId, repo.name));
  }
  return { ...res, text: marked.text, repo: repo?.name ?? "*" };
}

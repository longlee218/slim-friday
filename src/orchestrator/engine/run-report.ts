import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../../config/agent-config";
import { appendTaskMemory } from "../../memory/memory-writer";
import { extractMemory } from "../../memory/repo-memory";
import { logger, setLogContext, tryLog } from "../../observability/logger";
import { clip } from "../../observability/redact";
import type { Repo } from "../../repos/repo-registry";
import { RESUME_FAILED } from "../../runtime/run-errors";
import { setTurnRepo } from "../../storage/run-store";
import { type FlowResult, resumeReasonOf } from "../turns/turn-result";
import type { RoleRunInput } from "./role-run-types";

/* What the app reads from the END of a background run's report (`repo: <name>`, `Memory:`) and how a failure is tagged. */

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "run-report" });

/** The last non-empty line of the form `repo: <name>` (optionally a bullet, bold or in backticks). */
const REPO_LINE = /^\s*[-*]?\s*\**repo\**\s*:\s*`?([\w.-]+)`?\s*$/i;

/**
 * Split the final report into text + the repo the agent named on its last non-empty line `repo: <name>`. The line is removed from the
 * text; the name counts only when it is one of `repos` (case-insensitive, returned as registered). No valid marker =
 * no repo (memory is then skipped, the ledger shows `*`).
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

/** Short title of a task for the repo memory (first line of the owner's text, capped). */
export const taskTitle = (text: string): string =>
  clip(text.trim().split("\n")[0] ?? "", 70) || "Agent change";

/**
 * Close a background run. A failure that kept its session (budget, error) is tagged resumable: `/go` continues that
 * session. A success names its repo on the last `repo:` line (validated against the workspace repos): the turn row, the
 * log context and the repo MEMORY.md (lessons of the `Memory:` section) follow it. No valid marker = no repo: the memory
 * is skipped and the ledger shows `*`.
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
  const memory = extractMemory(marked.text);
  const repo = marked.repo ?? i.repos.find((r) => r.name === res.repo);
  if (repo) {
    setLogContext({ repo: repo.name });
    tryLog(log, "set turn repo failed", () => setTurnRepo(d.db, i.turnId, repo.name));
    appendTaskMemory(d.config.agentHome, i.workspace, repo.name, taskTitle(i.text), memory);
  }
  return { ...res, text: memory.text, repo: repo?.name ?? "*" };
}

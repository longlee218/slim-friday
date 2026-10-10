import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalGateway } from "../../approvals/approval-types";
import { WORKSPACE_NAME, workspacePaths } from "../../config/workspace-paths";
import { logEvent, logger } from "../../observability/logger";
import { redactText } from "../../observability/redact";
import { gitOut, runGit } from "../../repos/git-cli";
import { recordFilesChanged } from "../../storage/files-changed";
import {
  getWorktreeByTask,
  setDelivered,
  setWorktreeStatus,
  type WorktreeRow,
} from "../../storage/worktree-store";
import { dropClone } from "../../workspaces/clone-cleanup";
import { UUID_RE } from "../../workspaces/clone-safety";
import { capStat } from "./diffstat-cap";

/* Local delivery of a clone with no GitHub origin: the owner gets the branch, the diffstat, a fetch command to
   copy and a patch file. The app never runs the fetch and never touches the owner repo. */

const log = logger.child({ module: "local-result-output" });

/** Largest patch attached to the Discord message; a bigger one is only named by path. */
export const PATCH_ATTACH_MAX_BYTES = 1_000_000;
/** The whole result message stays under this (Discord allows 2000). */
export const RESULT_MESSAGE_MAX = 1800;
/** Characters kept free for the buttons' answer line appended after a click. */
const RESULT_MARGIN = 100;
/** A base commit is a full hex sha (sha1 or sha256). */
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Characters a shell word may hold unquoted. */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** One line added when the clone has no usable origin url (none, or it carried credentials). */
const NO_ORIGIN_NOTE = "No origin url used (none, or it carried credentials): no PR offered.";
/** Break a triple backtick so a path or branch name cannot close the code fence. */
const fence = (s: string): string => s.replace(/```/g, "`\u200b``");

/** Shell-quote one word for a command the owner copies (display only, never executed here). */
export const shellQuote = (s: string): string =>
  SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/** The command that brings the clone's branch into the owner repo. */
export const fetchCommand = (wt: WorktreeRow): string =>
  `git -C ${shellQuote(wt.repoPath)} fetch ${shellQuote(wt.path)} ${shellQuote(`${wt.branch}:${wt.branch}`)}`;

/** Dependencies of the local result gate. */
export interface LocalResultDeps {
  db: Database;
  approvals: ApprovalGateway;
  agentHome: string;
  /** True while a run of the thread holds its lock: Discard is then refused (a follow-up may be using the clone). */
  threadBusy?: (threadId: string) => boolean;
}

/** Reply to a Discard click while a run of the thread is using the clone. */
export const discardBusy = (taskId: string): string =>
  `Not discarded: a task is running in this thread. When it ends, use \`/cleanup ${taskId.slice(0, 8)}\`.`;

/** Inputs of the local result gate. */
export interface LocalResultInput {
  wt: WorktreeRow;
  taskId: string;
  threadId: string;
  /** Agent summary the reply starts with. */
  text: string;
}

/**
 * Local delivery: check the branch, scan the patch for secrets, write it next to the task, post the
 * Keep/Discard message. Returns the reply text. A found secret blocks the patch and the message.
 */
export async function finishLocalResult(
  deps: LocalResultDeps,
  o: LocalResultInput,
): Promise<string> {
  const { wt } = o;
  const { baseSha } = wt;
  const ws = wt.workspace;
  // Everything below is rebuilt from validated ids: a bad row gets no result (fail closed).
  if (
    !baseSha ||
    !SHA_RE.test(baseSha) ||
    !ws ||
    !WORKSPACE_NAME.test(ws) ||
    !UUID_RE.test(wt.taskId)
  )
    return `${o.text}\n\nResult not shared: the clone row is invalid.`;
  const head = await gitOut(["rev-parse", "--abbrev-ref", "HEAD"], wt.path);
  if (head !== wt.branch)
    return `${o.text}\n\nThe clone is on "${head}", not ${wt.branch}: no result shared.`;
  const count = Number(await gitOut(["rev-list", "--count", `${baseSha}..HEAD`], wt.path));
  const dirty = (await gitOut(["status", "--porcelain"], wt.path))
    ? "\nUncommitted changes remain in the clone."
    : "";
  if (count === 0) return `${o.text}\n\nNo commits on ${wt.branch}.${dirty}`;
  const patch = (await runGit(["format-patch", "--stdout", `${baseSha}..HEAD`], wt.path)).stdout;
  // The same secret scan as the PR path, BEFORE anything is written or attached.
  if (redactText(patch) !== patch) {
    logEvent(log, "result.blocked", { repo: wt.repo, branch: wt.branch, reason: "secret" }, "warn");
    return `${o.text}\n\nPossible secret in the changes of ${wt.branch}: no patch written. Remove it and commit again.`;
  }
  const stat = await gitOut(["diff", "--stat", `${baseSha}...HEAD`], wt.path);
  recordFilesChanged(deps.db, wt.taskId, stat); // ledger: files changed
  const taskDir = workspacePaths(deps.agentHome).workspace(ws).task(wt.taskId).root;
  const patchPath = join(taskDir, `${wt.taskId.slice(0, 8)}.patch`);
  mkdirSync(taskDir, { recursive: true, mode: 0o700 });
  writeFileSync(patchPath, patch, { mode: 0o600 });
  const attach = Buffer.byteLength(patch) <= PATCH_ATTACH_MAX_BYTES;
  setDelivered(deps.db, wt.taskId, "local", patchPath);

  const task8 = wt.taskId.slice(0, 8);
  const head1 = `Result of ${wt.repo}: branch ${wt.branch} (base ${wt.base} ${baseSha.slice(0, 8)}), ${count} commit(s).${dirty}${wt.originUrl ? "" : `\n${NO_ORIGIN_NOTE}`}`;
  // The fetch command is never cut; the other parts are capped to fit (the stat first, then the head).
  const fetchBlock = `\`\`\`\n${fence(fetchCommand(wt))}\n\`\`\``;
  const tail = [
    "Bring it into your repo (copy and run yourself):",
    fetchBlock,
    attach ? `Patch attached (${patchPath}).` : `Patch too large to attach: ${patchPath}`,
    `Keep it, or Discard (removes the clone and deletes branch ${wt.branch}). No answer keeps it; remove it later with \`/cleanup ${task8}\`.`,
  ].join("\n");
  const budget = RESULT_MESSAGE_MAX - RESULT_MARGIN;
  const headCapped = head1.slice(0, Math.max(200, budget - tail.length - 60));
  const fixed = headCapped.length + tail.length + "\n```\n\n```\n".length;
  const content = `${headCapped}\n\`\`\`\n${capStat(stat, budget - fixed)}\n\`\`\`\n${tail}`;

  const posted = await deps.approvals.postDecision?.({
    taskId: o.taskId,
    threadId: o.threadId,
    content,
    filePath: attach ? patchPath : undefined,
    onClick: (choice) => decide(deps, wt.taskId, choice),
  });
  logEvent(log, "result.local", {
    repo: wt.repo,
    branch: wt.branch,
    commits: count,
    posted: !!posted,
  });
  // Posted: the message above is the result. Not posted (no channel / test): the reply carries it.
  return `${o.text}\n\n${posted ? `Result posted: ${wt.branch}, ${count} commit(s).` : content}`;
}

/** The owner's click: `keep` marks the row, `discard` removes the clone. Only an undecided delivered row changes. */
async function decide(
  deps: Pick<LocalResultDeps, "db" | "agentHome" | "threadBusy">,
  taskId: string,
  choice: "keep" | "discard",
): Promise<string> {
  const row = getWorktreeByTask(deps.db, taskId);
  if (row?.status !== "delivered") return "This action expired.";
  if (choice === "keep") {
    setWorktreeStatus(deps.db, taskId, "kept");
    return `Kept. Remove it later with \`/cleanup ${taskId.slice(0, 8)}\`.`;
  }
  // A follow-up of this thread may be running in the clone: keep everything, the click is spent but the row stays `delivered`.
  if (deps.threadBusy?.(row.threadId)) return discardBusy(taskId);
  const removed = await dropClone(deps.db, deps.agentHome, row);
  logEvent(log, "result.discarded", { repo: row.repo, branch: row.branch, removed });
  return removed
    ? `Discarded: the clone and branch ${row.branch} are removed.`
    : "Refused: the clone row is invalid.";
}

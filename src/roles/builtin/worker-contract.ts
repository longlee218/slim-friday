import { REPORT_TOOL } from "../../mcp/orchestration/tools/ReportTool/constants";

/*
 * Shared text of the task-worker contracts (scout, researcher, developer and the six roster specialists), phase 2b of the
 * role upgrade. Two lines: the rest of how a run fits the team (inputs, hand-offs, failures, limits) is the preloaded
 * team skill. The teammate does not get this block.
 */

/** `{OWNER_CONTACT}` of roles with no owner contact (roster, scout, researcher). */
export const NO_OWNER_CONTACT =
  "No owner contact: the owner is reached only through the teammate. A brief too unclear to start ends with NEEDS_CLARIFICATION and the one question that unblocks it (in requests).";

/**
 * The shared worker block, placed right after a role's Mission and Method. `ownerContact` is the one line that differs
 * (NO_OWNER_CONTACT, or the developer's ask line).
 */
export const workerTeamFacts = (ownerContact: string): string => `## How the team works
- How a run fits the team (who you talk to, inputs, hand-offs, failures, limits) is the team skill, preloaded below. Reporting: the ${REPORT_TOOL} tool, as the worker-reporting skill describes. A run ends with one \`result\`, or with a \`blocker\`, which itself ends the run.
- ${ownerContact}`;

/** Write roles without a shell (humanizer-writer): files stay uncommitted and that is a completed result. */
export const NO_SHELL_WRITER_FACT =
  '- No shell: you cannot run, build, preview, install, test or commit. Files you write stay uncommitted in the working tree. List each one in the result as { title, path }. Committing, and any step that needs a command, belongs to a member with a shell (developer). A brief that asks you to commit is answered with the files written and "not committed" in the summary, status COMPLETED. It is not a blocker.';

/** Roster roles with a shell and write (tester, devops, designer): a local commit only when the brief asks; delivery stays the developer's. */
export const shellCommitFact = (prefixes: string): string =>
  `- Commit: only when the brief asks, a local commit of only the files of this item, one short conventional line (${prefixes}), never any AI or model attribution, never a secret or key file. Push, merge, PR and deleting existing files are the developer's (checked tools, owner approval). The shell does not block them, so do not run them.`;

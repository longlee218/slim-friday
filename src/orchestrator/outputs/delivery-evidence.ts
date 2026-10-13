import type { Database } from "bun:sqlite";
import { parseCommand } from "../../guardrails/bash-parser";
import { toolInputsOfTurn } from "../../storage/run-metrics-store";
import { BASH_TOOL_NAME } from "../../tools/sdk-tool-names";

/** Counts of the delivery actions a run did, by kind. */
export type DeliveryActions = {
  commit: number;
  push: number;
  branch_create: number;
  pr_create: number;
  /** `git merge`, `gh pr merge`: a local finish. */
  merge: number;
  cherry_pick: number;
};

/** What a run delivered: action counts plus ids/URLs seen in its report (metadata only, never command text). */
export interface DeliveryEvidence {
  actions: DeliveryActions;
  /** PR URLs and commit shas found in the final report. */
  artifacts: string[];
  /** True when any action ran or any artifact was reported. */
  any: boolean;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const COMMIT_SHA = /\bcommit\s+`?([0-9a-f]{7,40})\b/gi;
/** Truncated tool previews are not valid JSON: the command is searched in the raw text then. */
const RAW_ACTIONS: ReadonlyArray<readonly [keyof DeliveryActions, RegExp]> = [
  ["commit", /\bgit\b[^&|;\n]*\bcommit\b/],
  ["push", /\bgit\b[^&|;\n]*\bpush\b/],
  ["pr_create", /\bgh\s+pr\s+create\b/],
  ["merge", /\bgit\b[^&|;\n]*\bmerge\b|\bgh\s+pr\s+merge\b/],
  ["cherry_pick", /\bgit\b[^&|;\n]*\bcherry-pick\b/],
];

/** Shells whose `-c` argument is a script to look into. */
const SHELLS = new Set(["bash", "sh", "zsh"]);

/** Git global options that take a value (`git -C dir commit`): skipped to find the subcommand. */
const GIT_OPTS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree"]);

/** Action of one simple command (`git commit`, `gh pr create`, ...), or undefined. */
function actionOfWords(words: string[]): keyof DeliveryActions | undefined {
  const [bin, ...rest] = words;
  if (bin === "gh") {
    if (rest[0] !== "pr") return undefined;
    return rest[1] === "create" ? "pr_create" : rest[1] === "merge" ? "merge" : undefined;
  }
  if (bin !== "git") return undefined;
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? "";
    if (GIT_OPTS_WITH_VALUE.has(w)) i++;
    else if (!w.startsWith("-") || args.length) args.push(w);
  }
  const [sub, ...tail] = args;
  if (sub === "commit") return "commit";
  if (sub === "push") return "push";
  if (sub === "merge") return "merge";
  if (sub === "cherry-pick") return "cherry_pick";
  // A branch is created by `checkout -b`, `switch -c`, `worktree add -b` or `branch <name>` (a listing or delete is not).
  const flags = tail.filter((w) => w.startsWith("-"));
  const names = tail.filter((w) => !w.startsWith("-"));
  if (sub === "checkout" && flags.includes("-b")) return "branch_create";
  if (sub === "switch" && (flags.includes("-c") || flags.includes("-C"))) return "branch_create";
  if (sub === "worktree" && names[0] === "add" && flags.includes("-b")) return "branch_create";
  if (sub === "branch" && names.length > 0 && !flags.some((f) => /^-(d|D|m|M|-delete)/.test(f)))
    return "branch_create";
  return undefined;
}

/** The shell command of one stored Bash call input (`{"command": ...}`), or the raw text when it is not valid JSON. */
const commandOf = (inputJson: string): { command: string; raw: boolean } => {
  try {
    const v = JSON.parse(inputJson) as { command?: unknown };
    return typeof v.command === "string"
      ? { command: v.command, raw: false }
      : { command: "", raw: false };
  } catch {
    return { command: inputJson, raw: true };
  }
};

/** Count the delivery actions of one command (compound commands count every part). */
function countActions(command: string, raw: boolean, into: DeliveryActions): void {
  if (!raw) {
    try {
      for (const seg of parseCommand(command)) {
        const a = actionOfWords(seg.words);
        if (a) into[a]++;
        // A wrapped shell (`bash -c '...'`): its script is a command line of its own.
        const at = seg.words.indexOf("-c");
        if (SHELLS.has(seg.words[0] ?? "") && at > 0 && seg.words[at + 1])
          countActions(seg.words[at + 1] as string, false, into);
      }
      return;
    } catch {
      // Unbalanced quotes: the coarse text check below decides.
    }
  }
  for (const [kind, re] of RAW_ACTIONS) if (re.test(command)) into[kind]++;
}

/**
 * Evidence that a run delivered: its Bash calls (main agent + subagents, parsed not logged) and the final report
 * (a GitHub PR URL or `commit <sha>`).
 */
export function deliveryEvidence(db: Database, turnId: string, text: string): DeliveryEvidence {
  const actions: DeliveryActions = {
    commit: 0,
    push: 0,
    branch_create: 0,
    pr_create: 0,
    merge: 0,
    cherry_pick: 0,
  };
  for (const input of toolInputsOfTurn(db, turnId, BASH_TOOL_NAME)) {
    const { command, raw } = commandOf(input);
    countActions(command, raw, actions);
  }
  const artifacts = [
    ...new Set([
      ...(text.match(PR_URL) ?? []),
      ...[...text.matchAll(COMMIT_SHA)].map((m) => m[1] ?? ""),
    ]),
  ].filter(Boolean);
  return {
    actions,
    artifacts,
    any: artifacts.length > 0 || Object.values(actions).some((n) => n > 0),
  };
}

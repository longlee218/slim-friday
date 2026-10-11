import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardFor } from "../src/guardrails/check-tool-call";
import { captureLogs } from "../src/observability/logger";
import { getStage } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { makeEnv } from "./helpers";

// Setup and run of the gated live SDD loop (see live-sdd-loop.spike.test.ts for what it asserts and how to run it).
export const RUN = process.env.SPIKE_SDD_LOOP === "1";
export const BUDGET = Number(process.env.SPIKE_SDD_BUDGET_USD ?? "0.5");
export const TIMEOUT = Number(process.env.SPIKE_SDD_TIMEOUT_MS ?? "900000");
export const AUTHOR = { name: "Spike Owner", email: "spike@example.com" };
/** Conventional commit subject (the AGENTS.md rule of the clones). */
export const CONVENTIONAL = /^(feat|fix|test|docs|refactor|chore)(\([^)]+\))?: .+/;

export const PLAN = `# Math helpers plan

repo: repo

## Global Constraints
- TypeScript, bun:test; sources in src/, tests in test/ named <module>.test.ts.

### Task 1: add
Create src/add.ts exporting add(a: number, b: number): number and test/add.test.ts (add(2, 3) is 5).

### Task 2: sub
Create src/sub.ts exporting sub(a: number, b: number): number and test/sub.test.ts (sub(5, 3) is 2).

### Task 3: mul
Create src/mul.ts exporting mul(a: number, b: number): number and test/mul.test.ts (mul(2, 3) is 6).
`;

export const DRIVER = (planPath: string) =>
  [
    `Approved plan (also saved at ${planPath}). Original task: implement the plan. Run the tests with: bun test`,
    "",
    "TEST DRIVER (a live check of the subagent loop): execute the plan with the superpowers:subagent-driven-development skill.",
    "For Task 2 only: after the implementer reports DONE and before you dispatch the reviewer, resume that same implementer with SendMessage (to = its name) and ask it to add a one-line comment above its function and commit it.",
  ].join("\n");

const roots: string[] = [];
process.on("exit", () => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

export const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });

/** Build the temp clone and agent home, run the REAL dev exec stage once, return the run result and its log lines. */
export async function runLoop() {
  // Temp clone with one initial commit; the agent home (skills plugin copies, logs) is a temp dir as well.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "friday-sdd-loop-")));
  roots.push(root);
  const clone = join(root, "repo");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "package.json"), '{"name":"sdd-loop","type":"module"}\n');
  writeFileSync(join(clone, ".gitignore"), "node_modules\n");
  git(clone, "add", ".");
  git(
    clone,
    "-c",
    `user.name=${AUTHOR.name}`,
    "-c",
    `user.email=${AUTHOR.email}`,
    "commit",
    "-q",
    "-m",
    "chore: init",
  );
  const baseSha = git(clone, "rev-parse", "HEAD").trim();

  const env = makeEnv({
    MODEL_DEV_EXEC: "haiku", // main agent on Haiku; subagents are dispatched with model haiku by the skill's choice or the cap
    MAX_BUDGET_USD: String(BUDGET),
    MAX_TURNS: "80",
    TIMEOUT_MS: String(TIMEOUT),
    LLM_PROVIDER: "anthropic",
  });
  const scratch = join(env.home, "scratch");
  mkdirSync(scratch, { recursive: true });
  const planPath = join(scratch, "plan.md");
  writeFileSync(planPath, PLAN);

  const stage = getStage("dev", "exec");
  const cap = captureLogs();
  const res = await runAgent({
    stage,
    stageIdx: 1,
    route: { cls: "mechanical" }, // Haiku class: the guard's subagent model cap is haiku and sonnet
    prompt: DRIVER(planPath),
    taskId: "sdd-loop",
    cwd: clone,
    additionalDirectories: [scratch],
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    gitAuthor: AUTHOR,
    gitBaseDir: clone,
    guard: guardFor(
      stage,
      {
        cwd: clone,
        writePaths: [clone],
        readPaths: [clone, scratch],
        gitWriteRepo: clone,
        allowedCommands: ["bun test"],
      },
      "mechanical",
    ),
  });
  cap.stop();
  return { res, lines: cap.lines, clone, baseSha };
}

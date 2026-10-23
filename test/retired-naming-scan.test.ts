import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readSkillsLock } from "./skills-lock-hash";

/** Every .ts file under `dir` (relative to the repo root), with its source. */
function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (p.endsWith(".ts")) out.push({ file: p, text: readFileSync(p, "utf8") });
  }
  return out;
}

/**
 * Names retired by the message / turn / task naming cleanup (P3.7). Built from parts so this file does not
 * contain them. History lives in docs/project-changelog.md and its archive only.
 */
const j = (...parts: string[]) => new RegExp(parts.join(""));

/** Retired functions, types, locals and file paths: banned in src, test AND the living docs. */
const SYMBOLS: Record<string, RegExp> = {
  // phase 02: ingress type and dep
  "ingress handler type": new RegExp(`\\b${["Handle", "Task"].join("")}\\b`),
  "ingress handler dep": new RegExp(`\\b${["handle", "Task"].join("")}\\b`),
  "ingress type file": j("task", "-type"),
  // phase 03: handler, commands, routing
  "turn handler factory": j("create", "Task", "Handler"),
  "turn handler deps": j("Task", "Handler", "Deps"),
  "command parser": j("parse", "Task", "Command"),
  "command type": new RegExp(`\\b${["Task", "Command"].join("")}\\b`),
  "route fn": new RegExp(`\\b${["route", "Task"].join("")}\\b`),
  "handler file path": j("handle", "-task"),
  "commands file path": j("task", "-commands"),
  "routing file path": j("task", "-routing"),
  "handler local": new RegExp(`\\b${["task", "Inserted"].join("")}\\b`),
  "turn repo getter": new RegExp(`\\b${["task", "Repo"].join("")}\\b`),
  // phase 04: turn-level orchestrator symbols
  "begin fn": new RegExp(`\\b${["begin", "Task"].join("")}\\b`),
  "fail fn": new RegExp(`\\b${["fail", "Task"].join("")}\\b`),
  "close fn": new RegExp(`\\b${["close", "Task"].join("")}\\b`),
  "log context fn": new RegExp(`\\b${["task", "LogContext"].join("")}\\b`),
  "role type fn": new RegExp(`\\b${["task", "TypeOf"].join("")}\\b`),
  "role kind fn": new RegExp(`\\b${["task", "KindOf"].join("")}\\b`),
  "approval cancel fn": new RegExp(`\\b${["cancel", "Task"].join("")}\\b`),
  "latest repo fn": new RegExp(`\\b${["latest", "Task", "Repo"].join("")}\\b`),
  "turns dir path": j("orchestrator", "/tasks", "/"),
  "tracker file path": j("/task", "-tracker"),
  "result file path": j("/task", "-result"),
  // phase 05: storage functions and status type
  "storage insert fn": new RegExp(`\\b${["insert", "Task"].join("")}\\b`),
  "storage finish fn": new RegExp(`\\b${["finish", "Task"].join("")}\\b`),
  "storage status fn": new RegExp(`\\b${["setTask", "Status"].join("")}\\b`),
  "storage repo fn": new RegExp(`\\b${["setTask", "Repo"].join("")}\\b`),
  "storage session setter": new RegExp(`\\b${["setTask", "Session"].join("")}\\b`),
  "storage session getter": new RegExp(`\\b${["task", "SessionId"].join("")}\\b`),
  "storage latest session fn": new RegExp(`\\b${["latestTask", "Session"].join("")}\\b`),
  "storage role fn": new RegExp(`\\b${["task", "Role"].join("")}\\b`),
  "storage interrupt fn": new RegExp(`\\b${["interruptRunning", "Tasks"].join("")}\\b`),
  "storage status type": new RegExp(`\\b${["Task", "Status"].join("")}\\b`),
  // memory v2 phase 1: workspace, location and pending-queue layers, size caps and their helpers
  "pending path field": new RegExp(`\\b${["memory", "Pending"].join("")}\\b`),
  "pending queue file": j("MEMORY", "\\.pending"),
  "location memory target": new RegExp(`\\b${["location", "Target"].join("")}\\b`),
  "workspace memory target": new RegExp(`\\b${["workspace", "Target"].join("")}\\b`),
  "location memory file fn": new RegExp(`\\b${["location", "MemoryFile"].join("")}\\b`),
  "location memory reader": new RegExp(`\\b${["read", "LocationMemory"].join("")}\\b`),
  "workspace memory reader": new RegExp(`\\b${["read", "WorkspaceMemory"].join("")}\\b`),
  "location memory cap": new RegExp(`\\b${["PER_LOCATION", "_CHARS"].join("")}\\b`),
  "workspace memory cap": new RegExp(`\\b${["WORKSPACE", "_CHARS"].join("")}\\b`),
  "root memory cap": new RegExp(`\\b${["ROOT", "_CHARS"].join("")}\\b`),
  "channel memory cap": new RegExp(`\\b${["CHANNEL", "_CHARS"].join("")}\\b`),
  "capped reader": new RegExp(`\\b${["read", "Capped"].join("")}\\b`),
  "memory cut fn": new RegExp(`\\b${["cap", "Memory"].join("")}\\b`),
  "memory cut file path": j("memory", "-cap", "\\b"),
  "pending cap constant": new RegExp(`\\b${["MEMORY_SAVE_PENDING", "_CAP_CHARS"].join("")}\\b`),
  "workspace memory template": new RegExp(`\\b${["workspace", "MemoryTemplate"].join("")}\\b`),
  "pending header": new RegExp(`\\b${["PENDING", "_HEADER"].join("")}\\b`),
  "location memory file path": j("location", "-memory", "\\b"),
  // memory v2 phase 3: rollover, rollover seed and lean runs (flush after compaction replaced them)
  "rollover seed fn": new RegExp(`\\b${["rollover", "Seed"].join("")}\\b`),
  "rollover request fn": new RegExp(`\\b${["request", "Rollover"].join("")}\\b`),
  "rollover run fn": new RegExp(`\\b${["run", "Rollover"].join("")}\\b`),
  "rollover take fn": new RegExp(`\\b${["take", "Rollover"].join("")}\\b`),
  "rollover scheduler fn": j("create", "Rollover", "Scheduler"),
  "rollover share constant": new RegExp(`\\b${["ROLLOVER", "_CONTEXT_SHARE"].join("")}\\b`),
  "mark rolled fn": new RegExp(`\\b${["mark", "Rolled"].join("")}\\b`),
  "lean run type": new RegExp(`\\b${["Lean", "Run"].join("")}\\b`),
  "old flush prompt": new RegExp(`\\b${["FLUSH", "_PROMPT"].join("")}\\b`),
  "rollover module paths": j(
    "(?:thread|rollover)",
    "-rollover|rollover",
    "-(?:flush|run|scheduler|seed|summary|prompts)",
  ),
};

/**
 * Retired SQL names and a log literal: banned in src and test (the docs may name them when they describe the
 * schema v3 migration).
 */
const SQL: Record<string, RegExp> = {
  // phase 06: SQL of the renamed table / columns / indexes (the table is `turns` since schema v3)
  "sql select from old table": j("FROM ", "tasks", "\\b"),
  "sql insert into old table": j("INTO ", "tasks", "\\b"),
  "sql update old table": j("UPDATE ", "tasks", "\\b"),
  "sql join old table": j("JOIN ", "tasks", "\\b"),
  "old thread index": j("idx_", "tasks", "_"),
  "old runs index": j("idx_runs_", "task"),
  "old parent column": j("parent_", "task", "_id"),
  "old proposal column": j("from_", "task", "_id"),
  "old kind literal": j("kind: ", '"task', '"'),
  // memory v2 phase 4: the rollover column of `thread_summaries` (dropped by migration 0009)
  "old summary rollover column": j("rolled", "_at", "\\b"),
};

/**
 * Retired by the Repo -> Location rename (schema v7): the `Repo` type, its loader and the `repo-registry` module.
 * Banned in src and test (the migration module and the frozen legacy storage files are exempt below).
 */
const REPO_CONCEPT: Record<string, RegExp> = {
  "repo type": new RegExp(`\\b${["Re", "po"].join("")}\\b`),
  "repo loader": j("load", "Repos"),
  "repo registry path": j("repo", "-registry"),
};

/**
 * Tool names retired by the action-tool merge (phase 4): the planner's seven tools became `Plan` actions and the
 * worker's two report tools `Report` actions; the lead's eleven tools became `Orchestrate` actions (`TaskStatus` is
 * retired as a storage type above). Banned in src and test (the docs are updated by the docs phase).
 */
const TOOLS: Record<string, RegExp> = Object.fromEntries(
  [
    ["Report", "Progress"],
    ["Report", "Result"],
    ["Get", "ProjectContext"],
    ["Get", "AgentCapabilities"],
    ["Create", "Plan"],
    ["Validate", "Plan"],
    ["Propose", "PlanRevision"],
    ["Get", "ExecutionProgress"],
    ["Analyze", "Blockers"],
    ["Dispatch", "Agent"],
    ["Steer", "Task"],
    ["Retry", "Task"],
    ["Cancel", "Task"],
    ["Forward", "Result"],
    ["Ask", "Owner"],
    ["Request", "Plan"],
    ["Approve", "Plan"],
    ["SetThread", "Title"],
    ["Register", "Location"],
  ].map((p) => [`retired tool ${p.join("")}`, new RegExp(`\\b${p.join("")}\\b`)]),
);

/** Planner removal (2026-10-22): the lead writes plans; no planner role, rolling waves or auto-applied revisions. */
const PLANNER: Record<string, RegExp> = Object.fromEntries(
  [
    ["MAX", "_WAVES"],
    ["request", "_plan"],
    ["deferred", "Scope"],
    ["PLANNER", "_KEY"],
    ["PLANNER", "_RUNNING"],
    ["WAVE", "_CAP"],
    ["WAVE", "_STALLED"],
    ["envelope", "Grew"],
  ].map((p) => [`retired planner name ${p.join("")}`, new RegExp(`\\b${p.join("")}\\b`)]),
);

const RETIRED: Record<string, RegExp> = {
  ...SYMBOLS,
  ...SQL,
  ...REPO_CONCEPT,
  ...TOOLS,
  ...PLANNER,
};

/**
 * `task_id` is a column only of worktrees and run_messages (staged tasks) and an SDK tool input: allowed in
 * their stores and the tests that touch them. Everywhere else the column is `turn_id`.
 */
const TASK_ID = j("task", "_id");
const TASK_ID_OK = [
  "turns.ts", // schema: turns.owned_task_id
  "events.ts", // schema: thread_events.task_id, run_messages.task_id
  "db-schema-baseline.test.ts",
  "worktree-store.ts",
  "item-age-store.ts", // reads turns.owned_task_id
  "item-age.test.ts",
  "db-retention-store.ts", // deletes by turns.owned_task_id
  "db-retention.test.ts",
  "files-changed.ts",
  "run-message-store.ts",
  "clone-retention.ts",
  "clone-retention.test.ts",
  "legacy-worktree-expiry.test.ts",
  "p22-review-fixes.test.ts",
  "guard-sdk-tool-catalog.test.ts",
  // owned_task_id: the link column of schema v6 (owned tasks)
  "owned-task-store.ts",
  "run-store.ts", // last turn of an owned task (turns.owned_task_id)
  "run-metrics-store.ts", // cost of the runs of owned tasks (turns.owned_task_id)
  // thread_events.task_id: the goal / task an outbox event is about (schema v8)
  "event-store.ts",
  "reflection-store.ts", // failure events of a goal to reflect on
  // artifacts.task_id: the task that produced the artifact (a lookup column, owner decision)
  "artifacts.ts",
  "artifact-store.ts",
  "artifact-list-store.ts", // taskStoreArtifacts: the files a task saved
  "dispatch-ready.ts", // writes the outbox event of a dispatched task
  // task_messages.task_id: the item a lead <-> worker message belongs to (team messages, 2026-10-23)
  "messages.ts",
  "task-message-store.ts",
  "task-message-fts-store.ts",
];

/**
 * Files allowed to hold a retired name: this file, the frozen legacy schema + the v3 migration (old names on
 * purpose), their tests, tests whose fixtures are old-shape DDL, and a spike reading an SDK message field.
 */
const EXEMPT: string[] = [
  "retired-naming-scan.test.ts",
  "db-schema.test.ts",
  "live-subagents.spike.test.ts",
];

test("src and test hold no retired message / turn / task name", () => {
  const files = [...sources("src"), ...sources("test")].filter(
    (f) => !EXEMPT.some((e) => f.file.endsWith(e)),
  );
  expect(files.length).toBeGreaterThan(100);
  const hits: string[] = [];
  // The lead's status tool is named like the retired type; its name constant (and the lead test that calls it) is the allowed place.
  for (const f of files)
    for (const [name, re] of Object.entries(RETIRED))
      if (
        re.test(f.text) &&
        !(
          name === "storage status type" &&
          ["TaskStatusTool/constants.ts", "tool-names.test.ts", "lead-runtime.test.ts"].some((ok) =>
            f.file.endsWith(ok),
          )
        )
      )
        hits.push(`${f.file}: ${name}`);
  for (const f of files)
    if (TASK_ID.test(f.text) && !TASK_ID_OK.some((ok) => f.file.endsWith(ok)))
      hits.push(`${f.file}: task id column`);
  expect(hits).toEqual([]);
});

test("retired table has no duplicate entry", () => {
  const all = [
    ...Object.values(SYMBOLS),
    ...Object.values(SQL),
    ...Object.values(REPO_CONCEPT),
  ].map((r) => r.source);
  expect(new Set(all).size).toBe(all.length);
  expect(Object.keys(SYMBOLS).filter((k) => k in SQL)).toEqual([]);
});

test("docs hold no retired file or symbol name (changelog history excepted)", () => {
  const docs = readdirSync("docs").filter(
    (f) => f.endsWith(".md") && !f.startsWith("project-changelog"),
  );
  expect(docs.length).toBeGreaterThan(3);
  const hits: string[] = [];
  for (const d of docs) {
    const text = readFileSync(join("docs", d), "utf8");
    // The lead's `TaskStatus` tool shares its name with the retired storage type: docs may name the tool.
    for (const [name, re] of Object.entries(SYMBOLS))
      if (re.test(text) && name !== "storage status type") hits.push(`docs/${d}: ${name}`);
  }
  expect(hits).toEqual([]);
});

test("relative markdown links in docs point at existing files", () => {
  const docs = readdirSync("docs").filter((f) => f.endsWith(".md"));
  const missing: string[] = [];
  let checked = 0;
  for (const d of docs) {
    // Fenced code blocks may hold `](...)` text that is not a link: strip them first.
    const text = readFileSync(join("docs", d), "utf8").replace(/```[\s\S]*?```/g, "");
    // `](target)` or `](target#anchor)`; skip absolute URLs and pure anchors.
    for (const m of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      const target = m[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      checked++;
      if (!existsSync(join(dirname(join("docs", d)), target))) missing.push(`docs/${d}: ${target}`);
    }
  }
  expect(checked).toBeGreaterThan(0);
  expect(missing).toEqual([]);
});

/**
 * Retired role names (`dev` renamed `developer`; the `assistant` role is gone): no role literal in src. The SDK's own `"assistant"` message type is not a role and stays legal.
 */
const ROLE_NAMES: Record<string, RegExp> = {
  "dev role literal": /["'`]dev["'`]/,
  "dev role tag": /\[dev\]/,
  "assistant role literal":
    /\bname:\s*["']assistant["']|getRole\(["']assistant["']\)|ASSISTANT_ROLE/,
};

test("src holds no `dev` or `assistant` role name", () => {
  const hits: string[] = [];
  for (const f of sources("src"))
    for (const [name, re] of Object.entries(ROLE_NAMES))
      if (re.test(f.text)) hits.push(`${f.file}: ${name}`);
  expect(hits).toEqual([]);
});

/** Every `.md` under `dir` (readdir does not skip hidden dirs, so `.agents` is included). */
function markdown(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...markdown(p));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

test("app-owned skills (`.agents/skills/**/*.md`, local lock entries) name no retired tool", () => {
  const local = Object.entries(readSkillsLock().skills).filter(([, e]) => e.sourceType === "local");
  const mds = local.flatMap(([n]) => markdown(join(".agents", "skills", n)));
  expect(mds.length).toBeGreaterThan(5); // the glob really reaches the hidden dir
  const hits: string[] = [];
  for (const f of mds) {
    const text = readFileSync(f, "utf8");
    for (const [name, re] of Object.entries(TOOLS)) if (re.test(text)) hits.push(`${f}: ${name}`);
  }
  expect(hits).toEqual([]);
});

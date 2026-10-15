import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

const RETIRED: Record<string, RegExp> = { ...SYMBOLS, ...SQL, ...REPO_CONCEPT };

/**
 * `task_id` is a column only of worktrees and run_messages (staged tasks) and an SDK tool input: allowed in
 * their stores and the tests that touch them. Everywhere else the column is `turn_id`.
 */
const TASK_ID = j("task", "_id");
const TASK_ID_OK = [
  "worktree-store.ts",
  "files-changed.ts",
  "run-message-store.ts",
  "clone-retention.ts",
  "clone-retention.test.ts",
  "legacy-worktree-expiry.test.ts",
  "p22-review-fixes.test.ts",
  "guard-sdk-tool-catalog.test.ts",
  // owned_task_id: the link column of schema v6 (owned tasks)
  "owned-task-store.ts",
  "status-snapshot.ts", // `/status` reads the waiting owned task's last turn
  "migrate-v6-owned-tasks.ts",
  "db-migrate-v6.test.ts",
  // thread_events.task_id: the goal / task an outbox event is about (schema v8)
  "migrate-v8-ddl.ts",
  "event-store.ts",
  "dispatch-ready.ts", // writes the outbox event of a dispatched task
];

/**
 * Files allowed to hold a retired name: this file, the frozen legacy schema + the v3 migration (old names on
 * purpose), their tests, tests whose fixtures are old-shape DDL, and a spike reading an SDK message field.
 */
const EXEMPT: string[] = [
  "retired-naming-scan.test.ts",
  "legacy-schema.ts",
  "legacy-migrate-v2.ts",
  "migrate-v3-turns.ts",
  // the Repo -> Location migration reads the legacy `repos/<n>/repo.yaml` layout on purpose
  "migrate-locations.ts",
  "migrate-locations-cli.ts",
  "migrate-locations-backup.ts",
  "migrate-locations-report.ts",
  "migrate-locations.test.ts",
  "db-migrate-v3.test.ts",
  "db-migrate-v4.test.ts",
  "db-migrate.test.ts",
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
          ["mcp-tool-names.ts", "lead-runtime.test.ts"].some((ok) => f.file.endsWith(ok))
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
    for (const [name, re] of Object.entries(SYMBOLS))
      if (re.test(text)) hits.push(`docs/${d}: ${name}`);
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

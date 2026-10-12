import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
 * contain them. Grows per phase. History lives in docs/project-changelog.md only.
 */
const j = (...parts: string[]) => new RegExp(parts.join(""));
const RETIRED: Record<string, RegExp> = {
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

/** File-name patterns also retired in the docs (docs/project-changelog.md keeps history and is not scanned). */
const RETIRED_IN_DOCS = [
  j("handle", "-task"),
  j("task", "-commands"),
  j("task", "-routing"),
  j("task", "-type"),
];

/** Files allowed to hold a retired name: this file only (the frozen legacy migration joins in phase 06). */
const EXEMPT: string[] = ["retired-naming-scan.test.ts"];

test("src and test hold no retired message / turn / task name", () => {
  const files = [...sources("src"), ...sources("test")].filter(
    (f) => !EXEMPT.some((e) => f.file.endsWith(e)),
  );
  expect(files.length).toBeGreaterThan(100);
  const hits: string[] = [];
  for (const f of files)
    for (const [name, re] of Object.entries(RETIRED))
      if (re.test(f.text)) hits.push(`${f.file}: ${name}`);
  expect(hits).toEqual([]);
});

test("docs hold no retired file name (changelog history excepted)", () => {
  const docs = readdirSync("docs").filter((f) => f.endsWith(".md") && f !== "project-changelog.md");
  expect(docs.length).toBeGreaterThan(3);
  const hits: string[] = [];
  for (const d of docs) {
    const text = readFileSync(join("docs", d), "utf8");
    for (const re of RETIRED_IN_DOCS) if (re.test(text)) hits.push(`docs/${d}: ${re.source}`);
  }
  expect(hits).toEqual([]);
});

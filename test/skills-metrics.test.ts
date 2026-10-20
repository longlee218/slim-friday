import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSkillsMetrics,
  readAppLogLines,
  skillsMetricsFromLines,
} from "../src/observability/skills-metrics";
import { calledSkillName, normalizeSkillName } from "../src/observability/skills-used";

const used = (time: number, role: string, available: string[], called: string[]) =>
  JSON.stringify({ level: 30, time, event: "skills.used", role, available, called });

const LOG = [
  used(1000, "developer", ["a", "b", "c"], ["a"]), // before the window
  used(5000, "developer", ["a", "b", "c"], ["a", "b"]),
  used(6000, "developer", ["a", "b", "c"], []),
  used(6000, "tester", ["x"], ["x"]),
  JSON.stringify({ time: 6000, event: "run.finished" }),
  "not json {",
];

test("per role: runs, average called, never called, inside the window only", () => {
  const s = skillsMetricsFromLines(LOG, 2000);
  expect(s).toEqual([
    { role: "developer", runs: 2, avgCalled: 1, neverCalled: ["c"] },
    { role: "tester", runs: 1, avgCalled: 1, neverCalled: [] },
  ]);
  expect(formatSkillsMetrics(s, 7)).toContain("developer: 2 run(s), avg 1.0 skill(s) called");
  expect(formatSkillsMetrics([], 7)).toContain("no worker runs");
});

test("reads the app.* jsonl files of a log dir; a missing dir is empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-metrics-"));
  writeFileSync(join(dir, "app.2026-10-20.1.jsonl"), `${LOG.join("\n")}\n`);
  writeFileSync(join(dir, "other.jsonl"), used(9000, "ghost", ["z"], []));
  const roles = skillsMetricsFromLines(readAppLogLines(join(dir, "app")), 0).map((r) => r.role);
  expect(roles).toEqual(["developer", "tester"]);
  expect([...readAppLogLines(join(dir, "nope", "app"))]).toEqual([]);
});

test("plugin prefix is normalized, a call without a skill name is ignored", () => {
  expect(normalizeSkillName("friday:plan-work")).toBe("plan-work");
  expect(normalizeSkillName("plan-work")).toBe("plan-work");
  expect(calledSkillName({ skill: "friday:using-skills" })).toBe("using-skills");
  expect(calledSkillName({})).toBeUndefined();
  expect(calledSkillName(null)).toBeUndefined();
});

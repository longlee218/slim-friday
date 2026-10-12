import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSISTANT_ROLE } from "../src/roles/builtin/assistant-role";

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
 * Names of the retired Q&A handoff (the assistant never proposes a change: the intent layer routes it).
 * Built from parts so this file does not contain them. History lives in docs/project-changelog.md only.
 */
const RETIRED: Record<string, RegExp> = {
  tool: new RegExp(["Delegate", "Task"].join("")),
  "tool constant": new RegExp(["DELEGATE", "TASK"].join("_")),
  "recommend handoff": new RegExp(["Recommend", "Handoff"].join("")),
  "delegate plumbing": new RegExp(["allow", "Delegate"].join("")),
  "delegate port": new RegExp(["delegate", "Check"].join("")),
  "handoff rules": new RegExp(["HANDOFF", "RULES"].join("_")),
  "tasks mcp server": new RegExp(["TASKS", "MCP", "SERVER"].join("_")),
  "tasks tool wire name": new RegExp(["mcp__tasks", ""].join("__")),
  "recommend capability": /["']recommend["']/,
  "handoff log events": /["']handoff\.[a-z_]+["']/,
  "rejected-plans block": new RegExp(["rejected", "Plans"].join("")),
};

test("src and test hold no name of the retired handoff tool (this file excepted)", () => {
  const files = [...sources("src"), ...sources("test")].filter(
    (f) => !f.file.endsWith("handoff-retired-scan.test.ts"),
  );
  expect(files.length).toBeGreaterThan(100);
  const hits: string[] = [];
  for (const f of files)
    for (const [name, re] of Object.entries(RETIRED))
      if (re.test(f.text)) hits.push(`${f.file}: ${name}`);
  expect(hits).toEqual([]);
});

test("the assistant is a plain read-only role: no write, shell or ask capability", () => {
  for (const c of ["write", "shell", "ask"])
    expect(ASSISTANT_ROLE.capabilities).not.toContain(c as never);
  expect(ASSISTANT_ROLE.gitGroups.join()).toBe("read");
});

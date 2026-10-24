import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS_DIR, loadConfig } from "../src/load-config";
import { loadTemplate } from "../src/templates";

const ALLOWED = ["Read", "Glob", "Grep", "Write", "Edit", "Bash", "WebSearch", "WebFetch"];

test("the shipped defaults include the Friday bot with its four file tools", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  const { snapshot, problems } = loadConfig({ defaultsDir: DEFAULTS_DIR, userDir });
  expect(problems).toEqual([]);
  const f = snapshot.bots.get("friday");
  expect(f?.name).toBe("Friday");
  expect(f?.tools).toEqual(["Read", "Glob", "Write", "Edit"]);
  expect(f?.workspaces).toEqual([]);
  expect(f?.instructions).toContain("<config dir>");
  expect(f?.instructions).toContain("<template dir>");
});

for (const [name, entry] of [
  ["code", "planner"],
  ["social-content", "strategist"],
  ["research", "lead"],
] as const) {
  test(`template ${name}: loads, entry bot is a member, members hand off with @Name`, () => {
    const { group, bots } = loadTemplate(name);
    expect(group.id).toBe(name);
    expect(group.entryBot).toBe(entry);
    expect(group.members.sort()).toEqual(bots.map((b) => b.id).sort());
    for (const b of bots) {
      const others = bots.filter((o) => o.id !== b.id);
      expect(others.some((o) => b.instructions.includes(`@${o.name}`))).toBe(true);
      for (const t of b.tools) expect(ALLOWED).toContain(t);
      expect(b.workspaces).toEqual([]);
    }
  });
}

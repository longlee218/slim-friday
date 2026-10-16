import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext } from "../src/policy/check-tool-call";

/* Phase 1g review fixes: a $HOME location must not reach AGENT_HOME (~/.friday) by a Glob/Grep search root.
   The shell is bounded by the OS sandbox (denyRead on AGENT_HOME), not parsed. */

const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-protected-")));
const home = join(base, "home");
const agent = join(home, ".friday");
mkdirSync(join(home, "proj"), { recursive: true });
mkdirSync(join(agent, "data"), { recursive: true });
writeFileSync(join(agent, "data", "agent.db"), "x");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ctx: GuardrailContext = {
  cwd: home,
  readPaths: [home],
  writePaths: [home],
  denyPaths: [agent],
  allowInside: [],
};
const run = (tool: string, input: Record<string, unknown>, c = ctx) =>
  checkToolCall(tool, input, c).decision;

test("Glob/Grep: a search root containing the agent home is denied, whatever the pattern", () => {
  expect(run("Grep", { pattern: "x" })).toBe("deny");
  expect(run("Grep", { pattern: "x", path: "." })).toBe("deny");
  expect(run("Grep", { pattern: "x", path: home })).toBe("deny");
  expect(run("Grep", { pattern: "x", glob: ".friday/**" })).toBe("deny");
  expect(run("Glob", { pattern: ".friday/**" })).toBe("deny");
  expect(run("Glob", { pattern: "**/agent.db" })).toBe("deny");
  expect(run("Glob", { pattern: "*.ts", path: join(home, "proj") })).toBe("allow");
  expect(run("Grep", { pattern: "x", path: join(home, "proj") })).toBe("allow");
  // A root inside a granted dir stays usable.
  const own = join(agent, "data");
  expect(run("Grep", { pattern: "x" }, { ...ctx, cwd: own, allowInside: [own] })).toBe("allow");
});

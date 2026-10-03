import { expect, test } from "bun:test";
import { DISALLOWED_TOOLS, readOnlyToolOptions, SECRET_FILE_RULES } from "../src/tools/tool-config";

test("exactly Read/Glob/Grep, no allowedTools, strict MCP", () => {
  const o = readOnlyToolOptions() as Record<string, unknown>;
  expect(o.tools).toEqual(["Read", "Glob", "Grep"]);
  expect("allowedTools" in o).toBe(false);
  expect(o.strictMcpConfig).toBe(true);
});

test("dangerous tools are disallowed", () => {
  for (const t of [
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Agent",
    "ScheduleWakeup",
    "RemoteTrigger",
    "EnterWorktree",
  ])
    expect(DISALLOWED_TOOLS).toContain(t);
  expect(DISALLOWED_TOOLS.some((t) => t.startsWith("Cron"))).toBe(true);
});

test("secret-file deny rules are part of disallowedTools", () => {
  const d = readOnlyToolOptions().disallowedTools;
  for (const r of [
    "Read(**/.env*)",
    "Read(**/*.pem)",
    "Read(**/*.key)",
    "Read(**/id_rsa*)",
    "Read(**/credentials*)",
  ]) {
    expect(SECRET_FILE_RULES).toContain(r);
    expect(d).toContain(r);
  }
});

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext } from "../src/guardrails/check-tool-call";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { as, base, CLONE, decide, PLANS, tmp } from "./subagent-scope-helper";

describe("implementer test commands (the repo's test command is allowlisted for subagents too)", () => {
  const sh = (command: string) => decide("implementer", BASH_TOOL_NAME, { command }).decision;
  const rows: [string, "allow" | "deny"][] = [
    ["bun test", "allow"],
    ["bun test src/a.test.ts", "allow"],
    ["bun test src/a.test.ts -t name", "allow"],
    ["bun test --bail", "allow"],
    ["bun test --bail=3 --coverage", "allow"],
    ["bun test --coverage", "allow"],
    ["bun test --rerun-each 2 --only", "allow"],
    ["bun test -t 'name with spaces'", "allow"],
    ["bun test --timeout=5000 test/a.test.ts", "allow"],
    ["bun test --watch", "deny"],
    ["bun test -w", "deny"],
    ["bun test --hot", "deny"],
    ["bun test --inspect=0.0.0.0", "deny"],
    ["bun test /etc/passwd", "deny"],
    ["bun test ../other", "deny"],
    ["bun test --preload=/tmp/x.ts", "deny"],
    ["bun test ~/x", "deny"],
    ["bun test && curl https://evil.example", "deny"],
    ["bun test; rm -rf /", "deny"],
    ["bun test $(whoami)", "deny"],
    ["bun test > /tmp/out", "deny"],
    ["cd . && bun test", "allow"],
    // other runners are NOT the configured command: ask -> deny for a subagent
    ["npm test", "deny"],
    ["pytest", "deny"],
    ["make test", "deny"],
    ["bun run test", "deny"],
    ["cargo test", "deny"],
    ["go test ./...", "deny"],
    // reads and git reads are allowed
    ["ls", "allow"],
    ["git status", "allow"],
    ["git diff --stat", "allow"],
    ["git rev-parse HEAD", "allow"],
  ];
  for (const [cmd, want] of rows) test(`${cmd} -> ${want}`, () => expect(sh(cmd)).toBe(want));
  // Flags outside the allowlist are never auto-allowed: main agent asks, a subagent is denied.
  const NOT_ALLOWLISTED = [
    "bun test --reporter=junit --reporter-outfile=out.xml",
    "bun test --reporter=junit --reporter-outfile=.git/x",
    "bun test --coverage-dir=.git/hooks",
    "bun test --preload ./x.ts",
    "bun test --cwd=x",
    "bun test -C x",
    "bun test --config=x",
    "bun test --env-file=.env",
    "bun test --tsconfig-override=x",
    "bun test --define=a=b",
    "bun test --install=force",
    "bun test --conditions=x",
    "bun test --timeout=a/b",
    "bun test -t a/b",
    "bun test .git/hooks",
    "bun test .env",
    "bun test .husky/x",
    "bun test src/$X",
    "bun test --bail=x",
  ];
  for (const c of NOT_ALLOWLISTED)
    test(`not auto-allowed: ${c}`, () => {
      expect(sh(c)).toBe("deny");
      expect(checkToolCall(BASH_TOOL_NAME, { command: c }, base).decision).not.toBe("allow");
    });
  test("without a configured test command nothing runs", () => {
    const noCmd: GuardrailContext = { ...as("implementer"), allowedCommands: [] };
    expect(checkToolCall(BASH_TOOL_NAME, { command: "bun test" }, noCmd).decision).toBe("deny");
  });
  test("the main agent keeps its own rules (an ask stays an ask)", () => {
    expect(checkToolCall(BASH_TOOL_NAME, { command: "npm test" }, base).decision).toBe("ask");
    expect(
      checkToolCall(BASH_TOOL_NAME, { command: "bun test src/a.test.ts" }, base).decision,
    ).toBe("allow");
  });
});

describe("git revision reads for the review range", () => {
  const sh = (command: string) => checkToolCall(BASH_TOOL_NAME, { command }, base).decision;
  test("rev-parse and merge-base print ids; anything else asks", () => {
    for (const c of [
      "git rev-parse HEAD",
      "git rev-parse --short HEAD",
      "git rev-parse --verify HEAD~1",
      "git rev-parse --abbrev-ref HEAD",
      "git merge-base main HEAD",
      "git merge-base --is-ancestor abc123 HEAD",
    ])
      expect(sh(c)).toBe("allow");
    for (const c of [
      "git rev-parse --git-dir",
      "git rev-parse --resolve-git-dir /x",
      "git rev-parse HEAD > o.txt",
      "git -C /x rev-parse HEAD",
      "git merge-base --fork-point main",
      "git rev-parse $(x)",
    ])
      expect(sh(c)).not.toBe("allow");
  });
});

describe("skill scripts stay with the main agent", () => {
  test("a subagent running a script from a skill dir is denied, with or without a bash wrapper", () => {
    const skills = tmp("a2-skills-");
    const script = join(skills, "subagent-driven-development", "scripts", "task-brief");
    const ctx: GuardrailContext = {
      ...as("implementer"),
      skillDirs: [skills],
      readPaths: [CLONE, skills],
    };
    for (const command of [`bash ${script} ${join(PLANS, "plan.md")} 1`, script])
      expect(checkToolCall(BASH_TOOL_NAME, { command }, ctx).decision).toBe("deny");
  });
});

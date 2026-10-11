import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext } from "../src/guardrails/check-tool-call";
import { GIT_TOOL } from "../src/mcp/mcp-tool-names";
import { BASH_TOOL_NAME, EDIT_TOOL_NAME, WRITE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { as, base, CLONE, decide, GIT_DIR, git, PLANS } from "./subagent-scope-helper";

describe("implementer writes only inside the clone", () => {
  const w = (file_path: string) =>
    decide("implementer", WRITE_TOOL_NAME, { file_path, content: "x" }).decision;
  test("clone files and the SDD workspace in the clone are allowed", () => {
    expect(w(join(CLONE, "src", "a.ts"))).toBe("allow");
    expect(w(join(CLONE, ".superpowers", "sdd", "plan", "task-1-report.md"))).toBe("allow");
    expect(decide("implementer", EDIT_TOOL_NAME, { file_path: join(CLONE, "a.ts") }).decision).toBe(
      "allow",
    );
  });
  test("outside the clone (also the main agent's plans dir), the git dir and secrets are denied", () => {
    expect(w(join(PLANS, "x.md"))).toBe("deny"); // the main agent may write here, a subagent may not
    expect(
      checkToolCall(WRITE_TOOL_NAME, { file_path: join(PLANS, "x.md"), content: "x" }, base)
        .decision,
    ).toBe("allow");
    for (const p of [
      "/etc/hosts",
      "/tmp/x",
      join(CLONE, "..", "x"),
      join(CLONE, GIT_DIR, "config"),
      join(CLONE, GIT_DIR, "hooks", "pre-commit"),
      join(CLONE, ".env"),
      join(CLONE, "keys", "id_rsa"),
      join(CLONE, "a.pem"),
    ])
      expect(w(p)).toBe("deny");
  });
  test("no clone known: no write path at all (fail closed)", () => {
    const noClone: GuardrailContext = { ...as("implementer"), gitWriteRepo: undefined };
    expect(
      checkToolCall(WRITE_TOOL_NAME, { file_path: join(CLONE, "a.ts"), content: "x" }, noClone)
        .decision,
    ).toBe("deny");
  });
  test("Bash redirects follow the same list", () => {
    const sh = (command: string) => decide("implementer", BASH_TOOL_NAME, { command }).decision;
    expect(sh(`echo hi > ${join(CLONE, "o.txt")}`)).toBe("deny"); // an ask in a subagent is a deny
    expect(sh(`echo hi > ${join(PLANS, "o.txt")}`)).toBe("deny");
    expect(sh(`touch ${join(CLONE, GIT_DIR, "x")}`)).toBe("deny");
  });
});

describe("implementer commits through the git MCP tools in the clone only", () => {
  const c = (input: Record<string, unknown>) =>
    decide("implementer", git(GIT_TOOL.COMMIT), input).decision;
  test("add, commit and status in the clone are allowed", () => {
    expect(decide("implementer", git(GIT_TOOL.ADD), { path: CLONE }).decision).toBe("allow");
    expect(decide("implementer", git(GIT_TOOL.STATUS), { path: CLONE }).decision).toBe("allow");
    expect(c({ path: CLONE, message: "feat: add parser" })).toBe("allow");
  });
  test("no amend, no author override, no no-verify, no AI attribution, no other path", () => {
    expect(c({ path: CLONE, message: "x", amend: true })).toBe("deny");
    expect(c({ path: CLONE, message: "x", author: { name: "a", email: "a@b.c" } })).toBe("deny");
    expect(c({ path: CLONE, message: "x", noVerify: true })).toBe("deny");
    for (const m of [
      "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>",
      "Generated with Claude Code",
    ])
      expect(c({ path: CLONE, message: m })).toBe("deny");
    expect(c({ path: PLANS, message: "x" })).toBe("deny");
    expect(c({ message: "x" })).toBe("deny");
  });
  test("tools beyond add/commit/status are denied: checkout, reset, push, log, rebase", () => {
    for (const t of [
      GIT_TOOL.CHECKOUT,
      GIT_TOOL.RESET,
      GIT_TOOL.PUSH,
      GIT_TOOL.LOG,
      GIT_TOOL.REBASE,
    ])
      expect(decide("implementer", git(t), { path: CLONE }).decision).toBe("deny");
  });
  test("shell git writes and push stay denied", () => {
    for (const command of [
      "git add .",
      'git commit -m "x"',
      "git push origin feat",
      "git commit --amend",
    ])
      expect(decide("implementer", BASH_TOOL_NAME, { command }).decision).toBe("deny");
  });
});

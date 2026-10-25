import { expect, test } from "bun:test";
import type { Grant, PermissionSettings, ToolCall, ToolSpec } from "../src";
import { classifyTool, isIrreversible, scopeOf } from "../src/permission/classify-tool";
import { decide } from "../src/permission/decide";
import { matchGrant } from "../src/permission/match-grant";

const call = (input: Record<string, unknown> = {}, tool = "T", botId = "b1"): ToolCall => ({
  botId,
  conversationId: "c",
  tool,
  input,
});
const settings = (level: PermissionSettings["level"]): PermissionSettings => ({ level });
const run = (
  spec: ToolSpec | undefined,
  level: PermissionSettings["level"],
  extra: Partial<Parameters<typeof decide>[0]> = {},
) => decide({ call: call(), spec, grants: [], settings: settings(level), now: 100, ...extra });

const READ: ToolSpec = { name: "T", annotations: { readOnlyHint: true } };
const LOCAL: ToolSpec = { name: "T", sandboxed: true, annotations: {} };
const WRITE: ToolSpec = { name: "T", annotations: { destructiveHint: false } };
const EXTERNAL: ToolSpec = {
  name: "T",
  annotations: { destructiveHint: false, openWorldHint: true },
};
const DELETE: ToolSpec = {
  name: "T",
  annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

test("classifyTool by annotation, in order", () => {
  expect(classifyTool(undefined)).toBe("unknown");
  expect(classifyTool({ name: "T" })).toBe("unknown");
  expect(classifyTool(READ)).toBe("read");
  expect(classifyTool(LOCAL)).toBe("local");
  expect(classifyTool(WRITE)).toBe("write");
  expect(classifyTool(EXTERNAL)).toBe("external");
  expect(classifyTool({ name: "T", annotations: { destructiveHint: true } })).toBe("destructive");
});

test("isIrreversible: destructive + not idempotent + open-world (MCP defaults when annotated)", () => {
  expect(isIrreversible(DELETE)).toBe(true);
  expect(isIrreversible({ name: "T", annotations: { destructiveHint: true } })).toBe(true);
  expect(isIrreversible(EXTERNAL)).toBe(false);
  expect(isIrreversible(READ)).toBe(false);
  expect(isIrreversible(undefined)).toBe(false);
});

test("an annotated tool that leaves the hints empty is irreversible (MCP defaults), a sandboxed one is not", () => {
  expect(isIrreversible({ name: "T", annotations: {} })).toBe(true);
  expect(isIrreversible({ name: "T", sandboxed: true, annotations: {} })).toBe(false);
});

test("scopeOf takes the scopeKeys of the input as strings", () => {
  const spec: ToolSpec = { name: "T", scopeKeys: ["repo", "n"] };
  expect(scopeOf(call({ repo: "a", n: 3, other: 1 }), spec)).toEqual({ repo: "a", n: "3" });
  expect(scopeOf(call({}), spec)).toEqual({ repo: "", n: "" });
  expect(scopeOf(call({ x: 1 }), undefined)).toEqual({});
});

test("an unannotated tool is ask under every level", () => {
  for (const l of ["careful", "balanced", "autonomous"] as const)
    expect(run(undefined, l).outcome).toBe("ask");
});

test("level map: careful, balanced, autonomous", () => {
  expect(run(READ, "careful").outcome).toBe("allow");
  expect(run(LOCAL, "careful").outcome).toBe("ask");
  expect(run(LOCAL, "balanced").outcome).toBe("allow");
  expect(run(WRITE, "balanced").outcome).toBe("ask");
  expect(run(EXTERNAL, "balanced").outcome).toBe("ask");
  expect(run(WRITE, "autonomous").outcome).toBe("allow");
  expect(run(EXTERNAL, "autonomous").outcome).toBe("allow");
  expect(
    run({ name: "T", annotations: { destructiveHint: true, idempotentHint: true } }, "autonomous")
      .outcome,
  ).toBe("ask_always");
});

test("an irreversible call asks always", () => {
  expect(run(DELETE, "balanced").outcome).toBe("ask_always");
  expect(run(DELETE, "autonomous").outcome).toBe("ask_always");
});

const grant = (over: Partial<Grant> = {}): Grant => ({
  id: "g1",
  botId: "b1",
  effect: "always_allow",
  match: "tool",
  tool: "T",
  scope: { repo: "a" },
  createdAt: 0,
  ...over,
});

test("matchGrant: scope, bot, wildcard and expiry", () => {
  expect(matchGrant([grant()], call(), { repo: "a" }, 10)).toBeDefined();
  expect(matchGrant([grant()], call(), { repo: "b" }, 10)).toBeUndefined();
  expect(matchGrant([grant({ scope: { repo: "*" } })], call(), { repo: "zzz" }, 10)).toBeDefined();
  expect(
    matchGrant([grant({ botId: "*" })], call({}, "T", "other"), { repo: "a" }, 10),
  ).toBeDefined();
  expect(matchGrant([grant({ botId: "b2" })], call(), { repo: "a" }, 10)).toBeUndefined();
  expect(matchGrant([grant({ expiresAt: 10 })], call(), { repo: "a" }, 10)).toBeUndefined();
  expect(matchGrant([grant({ expiresAt: 11 })], call(), { repo: "a" }, 10)).toBeDefined();
  expect(matchGrant([grant({ tool: "X" })], call(), { repo: "a" }, 10)).toBeUndefined();
});

test("decide: grant allows an ask; tool override beats grant; floor beats everything; bot level beats level", () => {
  const spec: ToolSpec = { ...EXTERNAL, scopeKeys: ["repo"] };
  const c = call({ repo: "a" });
  const g = [grant()];
  const base = { call: c, spec, grants: g, settings: settings("balanced"), now: 10 };
  expect(decide(base).outcome).toBe("allow");
  expect(decide({ ...base, call: call({ repo: "b" }) }).outcome).toBe("ask");
  expect(decide({ ...base, settings: { level: "balanced", tools: { T: "deny" } } }).outcome).toBe(
    "deny",
  );
  expect(decide({ ...base, floorDenyReason: "credential path" })).toEqual({
    outcome: "deny",
    reason: "credential path",
  });
  expect(
    decide({ ...base, grants: [], settings: { level: "careful", botLevels: { b1: "autonomous" } } })
      .outcome,
  ).toBe("allow");
});

test("C1: a tool whose annotations leave the hints empty is not auto-allowed, even under autonomous", () => {
  for (const annotations of [{}, { readOnlyHint: false }, { idempotentHint: true }])
    expect(run({ name: "T", annotations }, "autonomous").outcome).not.toBe("allow");
});

test("C3: a per-tool 'ask' override on an irreversible call is ask_always", () => {
  const d = decide({
    call: call(),
    spec: DELETE,
    grants: [],
    settings: { level: "balanced", tools: { T: "ask" } },
    now: 1,
  });
  expect(d.outcome).toBe("ask_always");
});

test("I4: an irreversible call never matches a grant", () => {
  const g = [grant({ scope: {} })];
  const d = decide({
    call: call(),
    spec: DELETE,
    grants: g,
    settings: settings("balanced"),
    now: 1,
  });
  expect(d.outcome).toBe("ask_always");
});

test("I4: a grant must name every scope key of the tool", () => {
  expect(matchGrant([grant({ scope: {} })], call(), { repo: "a" }, 10)).toBeUndefined();
  expect(matchGrant([grant({ scope: {} })], call(), {}, 10)).toBeDefined();
});

test("C2: object scope values are told apart", () => {
  const spec: ToolSpec = { name: "T", scopeKeys: ["repo"] };
  expect(scopeOf(call({ repo: { name: "a" } }), spec)).not.toEqual(
    scopeOf(call({ repo: { name: "b" } }), spec),
  );
});

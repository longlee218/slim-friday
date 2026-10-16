import { expect, test } from "bun:test";
import { checkToolCall, type GuardrailContext } from "../src/guardrails/check-tool-call";
import { CREATE_PULL_REQUEST_TOOL } from "../src/mcp/effects/tools/CreatePullRequestTool/constants";
import { DELETE_PATHS_TOOL } from "../src/mcp/effects/tools/DeletePathsTool/constants";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { MERGE_BRANCH_TOOL } from "../src/mcp/effects/tools/MergeBranchTool/constants";
import { EFFECTS_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { checkEnvelope } from "../src/orchestrator/approval/check-envelope";
import { classifyToolCall } from "../src/orchestrator/approval/classify-tool-call";
import {
  ANY,
  type DispatchEnvelope,
  defaultEnvelope,
  envelopeFromPlan,
  envelopeWithGrants,
} from "../src/orchestrator/approval/envelope";
import { DEFAULT_BOUNDS } from "../src/orchestrator/approval/risk-types";

const base = defaultEnvelope("g1", ["api"], "/scratch");
const granted: DispatchEnvelope = envelopeWithGrants(base, [
  { tool: GIT_PUSH_TOOL, scope: { location: "api", branch: "feat/x" } },
  { tool: MERGE_BRANCH_TOOL, scope: { location: "api", into: "dev" } },
]);

test("default envelope: R0 + R1, no effect grants, the default bounds", () => {
  expect(base.classes).toEqual(["R0", "R1"]);
  expect(base.effects).toEqual([]);
  expect(base.bounds).toEqual(DEFAULT_BOUNDS);
});

test("DeletePaths needs no grant but is held to the bounds of the whole goal", () => {
  expect(checkEnvelope({ tool: DELETE_PATHS_TOOL, items: 200, bytes: 1 }, base).allow).toBe(true);
  expect(checkEnvelope({ tool: DELETE_PATHS_TOOL, items: 201 }, base)).toMatchObject({
    allow: false,
    code: "OVER_BOUNDS",
  });
  // The usage of earlier deletes counts.
  expect(
    checkEnvelope({ tool: DELETE_PATHS_TOOL, items: 1 }, base, { items: 200, bytes: 0 }).allow,
  ).toBe(false);
  expect(
    checkEnvelope({ tool: DELETE_PATHS_TOOL, items: 1, bytes: DEFAULT_BOUNDS.maxBytes + 1 }, base),
  ).toMatchObject({ code: "OVER_BOUNDS" });
});

test("push / merge need a grant on the location and the branch; a default branch is R4 even with a grant", () => {
  const push = (branch: string, env = granted, location = "api") =>
    checkEnvelope({ tool: GIT_PUSH_TOOL, location, branch }, env);
  expect(push("feat/x").allow).toBe(true);
  expect(push("feat/y")).toMatchObject({ code: "OUT_OF_ENVELOPE" });
  expect(push("feat/x", base)).toMatchObject({ code: "OUT_OF_ENVELOPE" });
  expect(push("feat/x", granted, "web")).toMatchObject({ code: "OUT_OF_ENVELOPE" });
  const anyBranch = envelopeWithGrants(base, [
    { tool: GIT_PUSH_TOOL, scope: { location: "api", branch: ANY } },
  ]);
  expect(push("whatever", anyBranch).allow).toBe(true);
  expect(push("main", anyBranch)).toMatchObject({ code: "R4" });
  expect(push("master", anyBranch)).toMatchObject({ code: "R4" });
  expect(
    checkEnvelope({ tool: MERGE_BRANCH_TOOL, location: "api", into: "dev" }, granted).allow,
  ).toBe(true);
  expect(
    checkEnvelope({ tool: MERGE_BRANCH_TOOL, location: "api", into: "feat/z" }, granted),
  ).toMatchObject({ code: "OUT_OF_ENVELOPE" });
  // A merge INTO a default branch asks the owner at every act: with a named grant, with `into: "*"`, whatever the grant.
  const anyMerge = envelopeWithGrants(base, [
    { tool: MERGE_BRANCH_TOOL, scope: { location: "api", into: ANY } },
  ]);
  for (const env of [granted, anyMerge])
    for (const into of ["main", "master", "develop", "release/1"])
      expect([
        into,
        checkEnvelope({ tool: MERGE_BRANCH_TOOL, location: "api", into }, env),
      ]).toEqual([into, expect.objectContaining({ allow: false, code: "R4" })]);
  expect(
    checkEnvelope({ tool: MERGE_BRANCH_TOOL, location: "api", into: "whatever" }, anyMerge).allow,
  ).toBe(true);
  expect(checkEnvelope({ tool: GIT_PUSH_TOOL, location: "api" }, granted)).toMatchObject({
    code: "OUT_OF_ENVELOPE",
  });
});

test("an approved plan becomes an envelope: R3 / pr opens push + PR, merge opens MergeBranch, GB bound applies", () => {
  const plan = {
    roles: ["developer"],
    locations: ["api"],
    riskClasses: ["R1", "R3"] as ("R1" | "R3")[],
    bounds: { maxItems: 8, maxGb: 2 },
    budgetUsd: 3,
    deliveryMode: "merge" as const,
  };
  const env = envelopeFromPlan(base, plan, { planId: "p1", version: 2 });
  expect(env.grantedBy).toBe("plan:p1@v2");
  expect(env.classes).toEqual(["R0", "R1", "R3"]);
  expect(env.bounds).toEqual({ maxItems: 200, maxBytes: 2 * 1024 ** 3 }); // plan steps are not deleted paths
  expect(env.effects.map((g) => g.tool as string).sort()).toEqual(
    [CREATE_PULL_REQUEST_TOOL, GIT_PUSH_TOOL, MERGE_BRANCH_TOOL].sort(),
  );
  expect(checkEnvelope({ tool: MERGE_BRANCH_TOOL, location: "api", into: "any" }, env).allow).toBe(
    true,
  );
  const keep = envelopeFromPlan(
    base,
    { ...plan, riskClasses: ["R1"], deliveryMode: "keep" },
    { planId: "p", version: 1 },
  );
  expect(keep.effects).toEqual([]);
});

test("the guard: effect tools pass only inside the envelope, unknown tools are denied, hard denies stay first", () => {
  const ctx = (env: DispatchEnvelope): GuardrailContext => ({
    cwd: "/loc",
    writePaths: ["/loc"],
    envelope: env,
    allowTools: [GIT_PUSH_TOOL, DELETE_PATHS_TOOL, MERGE_BRANCH_TOOL, CREATE_PULL_REQUEST_TOOL].map(
      (t) => mcpToolName(EFFECTS_MCP_SERVER, t),
    ),
  });
  const call = (tool: string, input: object, env = granted) =>
    checkToolCall(mcpToolName(EFFECTS_MCP_SERVER, tool), input as never, ctx(env));
  expect(call(GIT_PUSH_TOOL, { location: "api", branch: "feat/x" }).decision).toBe("allow");
  const out = call(GIT_PUSH_TOOL, { location: "api", branch: "feat/z" });
  expect(out.decision).toBe("deny");
  expect(out.reason).toContain("OUT_OF_ENVELOPE");
  expect(call(CREATE_PULL_REQUEST_TOOL, { location: "api", head: "feat/x" }).decision).toBe("deny");
  expect(call(DELETE_PATHS_TOOL, { paths: ["/loc/a"] }).decision).toBe("allow");
  // R4 reaches the tool, which asks the owner at that act.
  const any = envelopeWithGrants(base, [
    { tool: GIT_PUSH_TOOL, scope: { location: "api", branch: ANY } },
  ]);
  expect(call(GIT_PUSH_TOOL, { location: "api", branch: "main" }, any).decision).toBe("allow");
  // An unknown tool (the base guard asks) is R2 = outside the default envelope; granting R2 keeps the ask.
  expect(checkToolCall("SendFeedback", {}, ctx(base)).decision).toBe("deny");
  expect(
    checkToolCall("SendFeedback", {}, ctx({ ...base, classes: ["R0", "R1", "R2"] })).decision,
  ).toBe("ask");
  expect(checkToolCall("Bash", { command: "sudo ls" }, ctx(base)).decision).toBe("deny");
});

test("classifyToolCall: reads R0, writes R1, shell by allowlist, effect tools R2 / R3, unknown R2", () => {
  const c: GuardrailContext = { cwd: "/loc", writePaths: ["/loc"] };
  expect(classifyToolCall("Read", {}, c)).toBe("R0");
  expect(classifyToolCall("Edit", {}, c)).toBe("R1");
  expect(classifyToolCall("Bash", { command: "git log" }, c)).toBe("R0");
  expect(classifyToolCall("Bash", { command: "rm x" }, c)).toBe("R2");
  expect(classifyToolCall("Bash", {}, c)).toBe("R2");
  expect(classifyToolCall(mcpToolName(EFFECTS_MCP_SERVER, DELETE_PATHS_TOOL), {}, c)).toBe("R2");
  expect(classifyToolCall(mcpToolName(EFFECTS_MCP_SERVER, GIT_PUSH_TOOL), {}, c)).toBe("R3");
  expect(classifyToolCall("Whatever", {}, c)).toBe("R2");
});

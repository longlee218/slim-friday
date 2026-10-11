import { expect, test } from "bun:test";
import { subagentTiers } from "../src/config/model-routing";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { SEND_MESSAGE_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { exec, SEND_IN, SPAWN_IN, spawn, WT } from "./subagent-spawn-helper";

// Stateless guard rules for starting a subagent from the MAIN agent (recorded Q19 shapes): key allowlist, model cap,
// name rules, wrong-type message, SendMessage input keys.

test("the recorded spawn input is accepted once its type is a stage subagent", () => {
  expect(SPAWN_IN).toMatchObject({ name: "worker", model: "haiku", run_in_background: false });
  expect(spawn({}).decision).toBe("allow");
  expect(spawn({ subagent_type: "task-reviewer" }).decision).toBe("allow");
  expect(spawn({ name: undefined, model: undefined, run_in_background: undefined }).decision).toBe(
    "allow",
  );
});

test("key matrix: allowed keys pass, every other key is a hard deny", () => {
  for (const [k, v] of [
    ["description", "d2"],
    ["prompt", "p2"],
    ["model", "sonnet"],
    ["name", "task-3-impl"],
    ["run_in_background", false],
  ] as const)
    expect(spawn({ [k]: v }).decision).toBe("allow");
  for (const k of ["mode", "isolation", "effort", "team_name", "resume", "cwd", "tools"]) {
    const d = spawn({ [k]: "x" });
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain(k);
  }
});

test("background: only false or absent", () => {
  for (const v of [true, "true", 1, null, "false"])
    expect(spawn({ run_in_background: v }).decision).toBe("deny");
});

test("model cap: haiku and sonnet always; opus only for a design task; ids and junk denied", () => {
  expect(subagentTiers()).toEqual(["haiku", "sonnet"]);
  expect(subagentTiers("mechanical")).toEqual(["haiku", "sonnet"]);
  expect(subagentTiers("design")).toEqual(["haiku", "sonnet", "opus"]);
  for (const cls of [undefined, "mechanical", "standard"] as const) {
    expect(spawn({ model: "opus" }, exec(cls)).decision).toBe("deny");
    expect(spawn({ model: "sonnet" }, exec(cls)).decision).toBe("allow");
  }
  expect(spawn({ model: "opus" }, exec("design")).decision).toBe("allow");
  const d = spawn({ model: "opus" });
  expect(d.reason).toContain("haiku, sonnet");
  for (const m of ["claude-opus-5-5", "inherit", "", 5, null])
    expect(spawn({ model: m }).decision).toBe("deny");
  // A ctx without a tier table (not built by guardFor) fails closed: no explicit model at all.
  const bare = { ...exec(), subagentTiers: undefined };
  expect(spawn({ model: "haiku" }, bare).decision).toBe("deny");
  expect(spawn({ model: undefined }, bare).decision).toBe("allow");
});

test("name: a short slug only", () => {
  for (const n of ["a", "task-1-implementer", "Impl_2", "x".repeat(40)])
    expect(spawn({ name: n }).decision).toBe("allow");
  for (const n of ["", "-lead", "a b", "a/b", "x".repeat(41), "../x", "é", 3, null, "a;rm"])
    expect(spawn({ name: n }).decision).toBe("deny");
});

test("a type outside the stage list is denied with a message that names the valid types and the mapping", () => {
  for (const t of ["general-purpose", "claude", "Explore", "", undefined, 7]) {
    const d = spawn({ subagent_type: t });
    expect(d.decision).toBe("deny");
    expect(d.reason).toContain("Valid types: explorer, implementer, task-reviewer");
    expect(d.reason).toContain(
      "use subagent_type: implementer for the implementer prompt templates",
    );
    expect(d.reason).toContain(
      "use subagent_type: task-reviewer for the task reviewer, re-review and final code reviewer templates",
    );
  }
  // The plan stage only has the explorer: the message names only it, and offers no mapping.
  const plan = guardFor("plan", { readPaths: [WT] });
  const d = spawn({ subagent_type: "implementer" }, plan);
  expect(d.decision).toBe("deny");
  expect(d.reason).toContain("Valid types: explorer.");
  expect(d.reason).not.toContain("task-reviewer");
  // A long hostile type is clipped, never echoed whole.
  expect(spawn({ subagent_type: "x".repeat(500) }).reason.length).toBeLessThan(400);
});

test("SendMessage input: only the keys seen in the recorded Q19 call; any other key is denied", () => {
  const send = (over: Record<string, unknown>) =>
    checkToolCall(SEND_MESSAGE_TOOL_NAME, { ...SEND_IN, ...over }, exec()).decision;
  expect(Object.keys(SEND_IN).sort()).toEqual(
    ["content", "message", "recipient", "recipient_kind", "summary", "to", "type"].sort(),
  );
  expect(send({})).toBe("allow"); // the recorded input as is
  for (const k of ["mode", "team_name", "request_id", "approve", "reason", "cwd"])
    expect(send({ [k]: "x" })).toBe("deny");
});

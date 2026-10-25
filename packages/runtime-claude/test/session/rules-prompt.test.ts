import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot, BotRuntimeSpec, InboundTurn } from "@friday/core";
import { RULES_LABEL } from "@friday/core";
import { buildOptions } from "../../src/session/build-options";
import { formatTurn } from "../../src/session/format-turn";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "rules-")));
const bot: Bot = {
  id: "b1",
  name: "Ann",
  title: "Dev",
  instructions: "Be brief.",
  model: "sonnet",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [join(scratch, "ws")],
};
mkdirSync(join(scratch, "ws"));
const prompt = (
  extra: Partial<
    Pick<BotRuntimeSpec, "rules" | "memory" | "groupContext" | "groupRules" | "groupMemory">
  >,
) => {
  const o = buildOptions({
    spec: { bot, decide: async () => ({ behavior: "allow" }), ...extra },
    config: {
      agentHome: join(scratch, "home"),
      scratchRoot: join(scratch, "home", "runs"),
      oauthToken: "tok",
    },
    abort: new AbortController(),
    scratchDir: scratch,
  });
  return o.systemPrompt as string;
};
const turn: InboundTurn = {
  conversationId: "c",
  from: { kind: "user" },
  text: "go",
  hop: 0,
  context: [],
};

test("system prompt: rules come before memory, with the label", () => {
  const p = prompt({ rules: "- Never push to main.", memory: "## Facts\n- x" });
  expect(p).toContain(`## Your rules\n${RULES_LABEL}\n\n- Never push to main.`);
  expect(p.indexOf("## Your rules")).toBeLessThan(p.indexOf("## Your memory"));
});

test("system prompt: no rules, no heading", () => {
  expect(prompt({ memory: "m" })).not.toContain("## Your rules");
});

test("rules are not counted against the memory cap: long rules stay whole", () => {
  const rules = Array.from({ length: 50 }, (_, i) => `- rule ${i} ${"x".repeat(100)}`).join("\n");
  expect(prompt({ rules })).toContain(rules);
});

test("system prompt: group rules carry the label, after the group context, before the group memory", () => {
  const p = prompt({ groupContext: "X", rules: "- A", groupRules: "- G", groupMemory: "m" });
  expect(p).toContain(`## Group rules\n${RULES_LABEL}\n\n- G`);
  expect(p.indexOf("## Your rules")).toBeLessThan(p.indexOf("## Group context"));
  expect(p.indexOf("## Group context")).toBeLessThan(p.indexOf("## Group rules"));
  expect(p.indexOf("## Group rules")).toBeLessThan(p.indexOf("## Group memory"));
});

test("formatTurn never carries rules: they live in the system prompt", () => {
  expect(formatTurn(turn, {})).not.toContain("rules");
});

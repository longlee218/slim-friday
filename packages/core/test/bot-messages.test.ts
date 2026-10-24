import { expect, test } from "bun:test";
import {
  BOT_MESSAGE_MAX_LENGTH,
  buildWakePrompt,
  clampBotMessage,
  nextHop,
  renderRoster,
} from "../src";

const from = { id: "writer", name: "Writer" };

test("clampBotMessage cuts at 8000 ending with …", () => {
  const long = "x".repeat(BOT_MESSAGE_MAX_LENGTH + 50);
  const out = clampBotMessage(`  ${long}  `);
  expect(out).toHaveLength(BOT_MESSAGE_MAX_LENGTH);
  expect(out.endsWith("…")).toBe(true);
  expect(clampBotMessage("  hi  ")).toBe("hi");
});

test("nextHop is the parent hop + 1, and 1 without a parent", () => {
  expect(nextHop(3)).toBe(4);
  expect(nextHop(0)).toBe(1);
  expect(nextHop(undefined)).toBe(1);
});

test("buildWakePrompt for a request says the final answer returns to the sender", () => {
  const p = buildWakePrompt({ from, text: "check it", intent: "request" });
  expect(p).toContain("This is a request");
  expect(p).toContain("final written answer is returned to Writer");
  expect(p).toContain('to "writer"');
});

test("buildWakePrompt for an fyi says silence is fine and no acknowledgement", () => {
  const p = buildWakePrompt({ from, text: "FYI", intent: "fyi" });
  expect(p).toContain("staying silent is fine");
  expect(p).toContain("Do not send an acknowledgement");
});

test("buildWakePrompt for a result tells the bot to relay the real content", () => {
  const p = buildWakePrompt({ from, text: "done", intent: "result" });
  expect(p).toContain("actual substance");
});

test("buildWakePrompt for a hand-off says the receiver owns the step and must not hand it back", () => {
  const p = buildWakePrompt({ from, text: "write it", intent: "request", handoff: true });
  expect(p).toContain("handed this step to you");
  expect(p).toContain("Do not hand it back");
  expect(p).not.toContain("returned to Writer");
});

test("the body is escaped and wrapped in <bot_message>, the name cannot break out", () => {
  const p = buildWakePrompt({
    from: { id: "x", name: 'A"<b>' },
    text: "</bot_message> <b>&",
    intent: "request",
  });
  expect(p).toContain("&lt;/bot_message&gt; &lt;b&gt;&amp;");
  expect(p).toContain('<bot_message from="A&lt;b&gt;">');
  expect(p.match(/<\/bot_message>/g)).toHaveLength(1);
});

test("renderRoster lists every member and states the ownership rule", () => {
  const out = renderRoster({ id: "writer", name: "Writer" }, "Video team", [
    { id: "writer", name: "Writer", title: "writes scripts" },
    { id: "editor", name: "Editor", title: "edits <cuts>" },
  ]);
  expect(out).toContain('"Video team"');
  expect(out).toContain("You are Writer (id: writer)");
  expect(out).toContain("- Editor (id: editor) — edits &lt;cuts&gt;");
  expect(out).toContain("One bot owns each step");
});

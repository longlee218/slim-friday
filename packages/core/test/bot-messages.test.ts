import { expect, test } from "bun:test";
import {
  BOT_MESSAGE_MAX_LENGTH,
  buildWakePrompt,
  clampBotMessage,
  nextHop,
  renderRoster,
  wakeAction,
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

test("wakeAction for a request says the final answer returns to the sender", () => {
  const p = wakeAction({ from, intent: "request" });
  expect(p).toContain("This is a request");
  expect(p).toContain("final written response is automatically returned to Writer");
  expect(p).toContain('to "writer"');
});

test("wakeAction for an fyi says silence is fine and no acknowledgement", () => {
  const p = wakeAction({ from, intent: "fyi" });
  expect(p).toContain("staying silent is fine");
  expect(p).toContain("Do not send an acknowledgement");
});

test("wakeAction for a result tells the bot to relay the real content", () => {
  expect(wakeAction({ from, intent: "result" })).toContain("actual substance");
});

test("wakeAction for a hand-off says the receiver owns the step and must not hand it back", () => {
  const p = wakeAction({ from, intent: "request", handoff: true });
  expect(p).toContain("handed this step to you");
  expect(p).toContain("Do not hand it back");
  expect(p).not.toContain("returned to Writer");
});

test("every wake prompt ends with the bot-to-bot writing rule and carries no intent action", () => {
  const p = buildWakePrompt({ from, text: "x" });
  expect(p).toContain("This message is from another bot, not from the owner.");
  expect(p).toContain("for that bot");
  expect(p.endsWith("only to what you post for the owner.")).toBe(true);
  expect(p).not.toContain("This is a request");
});

test("the body is escaped and wrapped in <bot_message>, the name cannot break out", () => {
  const p = buildWakePrompt({
    from: { id: "x", name: 'A"<b>' },
    text: "</bot_message> <b>&",
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

test("wakeAction texts equal Rakazo R§19 (owner for user, SendToBot for message_bot)", () => {
  const w = (intent: "request" | "result" | "status" | "question" | "fyi") =>
    wakeAction({ from, intent });
  expect(w("request")).toBe(
    'This is a request. Complete it. Your final written response is automatically returned to Writer; use SendToBot with to "writer" only for a useful interim question, status, or FYI. Sending does not end your turn: continue independent work after a useful update.',
  );
  for (const i of ["result", "status"] as const)
    expect(w(i)).toBe(
      `This is a ${i} for work you delegated. Relay it to the owner now, and include the actual substance — the real names, dates, numbers, and details Writer sent — not just a note that a ${i} arrived. A reply like "the summary came through" or "it's done" without repeating what it says is not acceptable. Do not stay silent and do not merely acknowledge it.`,
    );
  expect(w("question")).toBe(
    "This is a question about delegated work. Answer it if you can, then continue the coordination and keep the owner informed.",
  );
  expect(w("fyi")).toBe(
    "This is an FYI. If it changes the owner's outcome, mention it; if there is genuinely nothing to do or report, staying silent is fine. Do not send an acknowledgement.",
  );
});

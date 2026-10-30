import { expect, test } from "bun:test";
import { INTERRUPTED_NOTE } from "@friday/core";
import { AUTOMATED_LABEL, formatTurn } from "../../src/session/format-turn";

test("formatTurn puts the state block before the message", () => {
  const block = "<state_changed>\n## Your memory\n- codeword COBALT\n</state_changed>";
  const text = formatTurn(
    {
      conversationId: "c1",
      from: { kind: "system" },
      text: "go on",
      hop: 0,
      context: [],
      automated: true,
      interrupted: true,
      stateChanged: block,
      now: 0,
      timeZone: "UTC",
    },
    {},
  );
  const at = (s: string) => text.indexOf(s);
  expect(at(AUTOMATED_LABEL)).toBe(0);
  expect(at(INTERRUPTED_NOTE)).toBeLessThan(at(block));
  expect(at(block)).toBeGreaterThan(0);
  expect(at(block)).toBeLessThan(at("[conversation c1]"));
});

test("formatTurn prints the computer slot line just before the time", () => {
  const text = formatTurn(
    {
      conversationId: "c1",
      from: { kind: "user" },
      text: "hi",
      hop: 0,
      context: [],
      computerSlots: "Computer slots on this machine: 2 slots",
      now: 0,
      timeZone: "UTC",
    },
    {},
  );
  const slots = text.indexOf("Computer slots on this machine: 2 slots");
  expect(slots).toBeGreaterThan(text.indexOf("[conversation c1]"));
  expect(text.slice(slots)).toMatch(/^Computer slots on this machine: 2 slots\n\n\S/);
  expect(text.split("\n\n").at(-2)).toBe("Computer slots on this machine: 2 slots");
});

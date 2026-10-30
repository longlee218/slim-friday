import { expect, test } from "bun:test";
import { type BotRuntimeSpec, MEMORY_LABEL, RULES_LABEL } from "../../src";
import { stateChangedBlock, stateHashes, stateParts } from "../../src/runs/session-state";

/** A runtime spec with only the fields `stateParts` reads. */
const spec = (over: Partial<BotRuntimeSpec>): BotRuntimeSpec =>
  ({ bot: { id: "ann" }, runKind: "owner", sessionKey: "ann", ...over }) as BotRuntimeSpec;

test("no change gives no block", () => {
  const parts = stateParts(spec({ memory: "- likes tea", rules: "- Be brief." }));
  expect(stateChangedBlock(parts, stateHashes(parts), [])).toBeUndefined();
});

test("a changed memory gives the memory section with its label", () => {
  const before = stateParts(spec({ memory: "- codeword AMBER", rules: "- Be brief." }));
  const now = stateParts(spec({ memory: "- codeword COBALT", rules: "- Be brief." }));
  const block = stateChangedBlock(now, stateHashes(before), []);
  expect(block?.changed).toEqual(["memory"]);
  expect(block?.text).toBe(
    "<state_changed>\n" +
      "Since this session started, Friday updated these parts of your instructions. They replace the earlier copies.\n" +
      `## Your memory\n${MEMORY_LABEL}\n\n- codeword COBALT\n` +
      "</state_changed>",
  );
  expect(block?.text).not.toContain(RULES_LABEL);
});

test("an emptied part is reported as now empty", () => {
  const before = stateParts(spec({ rules: "- Be brief.", scratchpad: "<scratchpad_open>x" }));
  const now = stateParts(spec({}));
  const block = stateChangedBlock(now, stateHashes(before), []);
  expect(block?.changed).toEqual(["rules", "scratchpad"]);
  expect(block?.text).toContain(`## Your rules\n${RULES_LABEL}\n\n(now empty)`);
  expect(block?.text).toContain("<scratchpad_open>\n(now empty)\n</scratchpad_open>");
});

test("a skipped part is never reported", () => {
  const before = stateParts(spec({ memory: "- old" }));
  const now = stateParts(spec({}));
  expect(stateChangedBlock(now, stateHashes(before), ["memory"])).toBeUndefined();
});

test("teammates are compared only for a direct spec", () => {
  const direct = stateParts(spec({ teammates: "- bob" }));
  expect(direct.teammates).toBe("- bob");
  const group = stateParts(spec({ groupId: "g", teammates: "- bob" }));
  expect("teammates" in group).toBe(false);
  const block = stateChangedBlock(
    stateParts(spec({ groupId: "g", teammates: "- carol" })),
    stateHashes(group),
    [],
  );
  expect(block).toBeUndefined();
});

test("hashes are 64-bit hex, and the hash of an empty part is empty", () => {
  const h = stateHashes({ memory: "abc", rules: "" });
  expect(h.memory).toMatch(/^[0-9a-f]{16}$/);
  // FNV-1a 64 of "abc".
  expect(h.memory).toBe("e71fa2190541574b");
  expect(h.rules).toBe("");
});

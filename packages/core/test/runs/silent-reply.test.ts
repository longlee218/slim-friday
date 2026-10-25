import { expect, test } from "bun:test";
import { isSilent, stripSentinel } from "../../src/runs/silent-reply";

test("isSilent: only the sentinel, repeated, with surrounding whitespace", () => {
  expect(isSilent("NO_RESPONSE")).toBe(true);
  expect(isSilent("  NO_RESPONSE\n")).toBe(true);
  expect(isSilent("NO_RESPONSE NO_RESPONSE")).toBe(true);
  expect(isSilent("NO_RESPONSENO_RESPONSE")).toBe(true);
  expect(isSilent("")).toBe(false);
  expect(isSilent("Done. NO_RESPONSE")).toBe(false);
  expect(isSilent("no_response")).toBe(false);
});

test("stripSentinel: a sentinel at the edge of prose goes, the prose stays", () => {
  expect(stripSentinel("All set.\n\nNO_RESPONSE")).toBe("All set.");
  expect(stripSentinel("NO_RESPONSE All set.")).toBe("All set.");
  expect(stripSentinel("Say NO_RESPONSE here")).toBe("Say NO_RESPONSE here");
  expect(stripSentinel("  plain  ")).toBe("plain");
  expect(stripSentinel("NO_RESPONSE")).toBe("");
});

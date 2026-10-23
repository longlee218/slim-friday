import { expect, test } from "bun:test";
import { note, quote, subtext } from "../src/providers/discord/ui/messages/hints";

test("hint styles: subtext, one-line italic note, quoted lines", () => {
  expect(subtext("by teammate")).toBe("-# by teammate");
  expect(note("a\n b *c*")).toBe("*a b c*");
  expect(quote("x\ny")).toBe("> x\n> y");
});

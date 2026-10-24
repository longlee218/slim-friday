import { expect, test } from "vitest";

test("vitest runs in jsdom", () => {
  expect(document.createElement("div")).toBeInstanceOf(HTMLElement);
});

import { expect, test } from "vitest";
import { setTheme } from "../../src/lib/theme";

test("setTheme dark sets data-theme, system removes it", () => {
  setTheme("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  setTheme("light");
  expect(document.documentElement.dataset.theme).toBe("light");
  setTheme("system");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
});

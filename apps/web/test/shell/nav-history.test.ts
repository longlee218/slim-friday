import { expect, test } from "vitest";
import { createNavHistory } from "../../src/components/shell/nav-history";

test("nav history drops forward entries after a new push", () => {
  const h = createNavHistory("/a");
  h.push("/b");
  h.push("/c");
  expect(h.back()).toBe("/b");
  h.push("/d");
  expect(h.canForward).toBe(false);
  expect(h.back()).toBe("/b");
});

test("ends return null", () => {
  const h = createNavHistory("/a");
  expect(h.back()).toBeNull();
  expect(h.forward()).toBeNull();
  expect(h.canBack).toBe(false);
});

test("lastChat follows the last /c/ path and defaults to Friday", () => {
  const h = createNavHistory("/tickets");
  expect(h.lastChat).toBe("/c/bot:friday");
  h.push("/c/bot:dev");
  h.push("/ops");
  expect(h.lastChat).toBe("/c/bot:dev");
});

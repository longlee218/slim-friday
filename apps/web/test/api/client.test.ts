import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vitest";
import { handleUnauthorized, setUnauthorizedHandler } from "../../src/api/client";
import { shouldRetry } from "../../src/api/query-client";

test("handleUnauthorized calls the handler only for UNAUTHORIZED", () => {
  const fn = vi.fn();
  setUnauthorizedHandler(fn);
  handleUnauthorized(new ORPCError("CONFLICT"));
  expect(fn).not.toHaveBeenCalled();
  handleUnauthorized(new ORPCError("UNAUTHORIZED"));
  expect(fn).toHaveBeenCalledTimes(1);
});

test("queries retry up to 2 times, never on a final answer", () => {
  expect(shouldRetry(0, new Error("net"))).toBe(true);
  expect(shouldRetry(2, new Error("net"))).toBe(false);
  expect(shouldRetry(0, new ORPCError("NOT_FOUND"))).toBe(false);
});

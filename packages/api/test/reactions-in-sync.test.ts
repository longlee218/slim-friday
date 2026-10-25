import { expect, test } from "bun:test";
import { MESSAGE_REACTIONS } from "@friday/contracts";
import { REACTIONS } from "@friday/core";

// core cannot import contracts, so the two emoji lists are kept equal by this test.
test("the engine and the contract list the same reactions", () => {
  expect([...REACTIONS]).toEqual([...MESSAGE_REACTIONS]);
});

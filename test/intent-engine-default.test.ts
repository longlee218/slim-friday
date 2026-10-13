import { expect, test } from "bun:test";
import { DEFAULT_INTENT_ENGINE } from "../src/config/agent-config";
import { makeEnv } from "./helpers";

// The default engine is one constant (agent-config.ts); the flip to `jev` is an owner step after the paid golden gate.
test("INTENT_ENGINE unset -> DEFAULT_INTENT_ENGINE; every explicit value stays valid", () => {
  expect(makeEnv().config.intent.engine).toBe(DEFAULT_INTENT_ENGINE);
  for (const e of ["haiku", "jev", "none"] as const)
    expect(makeEnv({ INTENT_ENGINE: e }).config.intent.engine).toBe(e);
});

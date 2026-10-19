import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one tester run. */
const BUDGET_USD = 1.5;

/** What this specialist does, after the shared contract. */
const JOB = `Built-in role: tester. Does: writes and runs tests for what the brief names, in the location (the shell runs in an OS sandbox). Reports the commands run, counts, and each failing case with its error. Scope: test files only; an application fault is reported with path and cause, not fixed. Never mark a failing run as passed.`;

/** The tester: Haiku, writes and runs tests in its location (sandboxed shell). */
export const TESTER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "tester",
  whenToUse:
    "Tests of existing or new code: write and run tests, find failing cases, report what breaks.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: [
    "worker-reporting",
    "test-driven-development",
    "verification-before-completion",
    "systematic-debugging",
    "requesting-code-review",
  ],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};

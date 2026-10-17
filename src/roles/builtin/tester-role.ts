import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one tester run. */
const BUDGET_USD = 1.5;

/** What this specialist does, after the shared contract. */
const JOB = `You are the tester. Write and run tests for what the brief names, in the location (the shell runs in an OS sandbox: no network). Report what you ran, what passed and what failed, with the exact failing case and the error. Change only test files; when the application code is wrong, say where and why, but leave the fix to the developer. Never mark a failing run as passed.`;

/** The tester: Haiku, writes and runs tests in its location (sandboxed shell). */
export const TESTER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "tester",
  whenToUse:
    "Tests of existing or new code: write and run tests, find failing cases, report what breaks; does not fix application code.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: [
    "test-driven-development",
    "verification-before-completion",
    "systematic-debugging",
    "requesting-code-review",
  ],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};

import { AGENT_TOOL_NAME } from "../../tools/sdk-tool-names";
import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** What this specialist does, after the shared contract. */
const JOB = `Built-in role: tester. Does: writes and runs tests for what the brief names, in the location (the shell runs in an OS sandbox). Reports the commands run, counts, and each failing case with its error. Scope: test files only; an application fault is reported with path and cause, not fixed. Never mark a failing run as passed.`;

/** Subagents of one tester run (parallel cap; depth 1 = a subagent starts none): small, for independent reviews or test runs. */
const SUBAGENTS = { parallel: 2, depth: 1 };

/** Run fact of the subagent opt-in (the shared contract no longer says "no subagents"). */
const SUBAGENT_FACT = `Up to ${SUBAGENTS.parallel} subagents in parallel (${AGENT_TOOL_NAME}) for independent read or test work. A subagent cannot report: you do.`;

/** The tester: Sonnet, writes and runs tests in its location (sandboxed shell). */
export const TESTER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "tester",
  noSubagents: false, // owner D7: the tester may spawn (tools limited by `subagentToolsFor`)
  subagents: SUBAGENTS,
  whenToUse:
    "Higher-level tests: integration, end-to-end, regression, edge and property cases; runs them, reports what breaks. A unit test of a change belongs to the developer.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: [
    "worker-reporting",
    "test-driven-development",
    "verification-before-completion",
    "systematic-debugging",
    "requesting-code-review",
    "property-based-testing",
  ],
  promptSections: () => [SPECIALIST_CONTRACT, JOB, SUBAGENT_FACT],
};

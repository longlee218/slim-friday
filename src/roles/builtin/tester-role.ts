import { PLAYWRIGHT_TOOLS } from "../../mcp/playwright/playwright-tool-names";
import { testerContract } from "../prompts/contracts/tester-contract";
import type { RoleDefinition } from "../role-types";
import { METHOD_SKILL, SPECIALIST_BASE, TEAM_SKILL } from "./specialist-contract";

/** Subagents of one tester run (parallel cap; depth 1 = a subagent starts none): small, for independent reviews or test runs. */
const SUBAGENTS = { parallel: 2, depth: 1 };

/** The tester: Sonnet, writes and runs tests in its location (sandboxed shell). */
export const TESTER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools, ...PLAYWRIGHT_TOOLS],
  name: "tester",
  noSubagents: false, // owner D7: the tester may spawn (tools limited by `subagentToolsFor`)
  subagents: SUBAGENTS,
  whenToUse:
    "Higher-level tests: integration, end-to-end, regression, edge and property cases; checks a running app in a browser; runs them and reports what breaks.",
  notFor: "Unit tests of a change; fixing the code.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: [
    METHOD_SKILL,
    TEAM_SKILL,
    "worker-reporting",
    "test-driven-development",
    "verification-before-completion",
    "systematic-debugging",
    "requesting-code-review",
    "property-based-testing",
    "test-master",
  ],
  preloadSkills: [METHOD_SKILL, TEAM_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: ["verification-before-completion", "test-master"], // called before the first edit or command (named in one prompt line)
  promptSections: () =>
    testerContract({
      subagentsParallel: SUBAGENTS.parallel,
    }),
};

import { BROWSER_TOOLS } from "../../mcp/browser/browser-tool-names";
import { testerContract } from "../prompts/contracts/tester-contract";
import type { RoleDefinition } from "../role-types";
import {
  METHOD_SKILL,
  SPECIALIST_BASE,
  SPECIALIST_BUDGET_USD,
  SPECIALIST_MAX_TURNS,
} from "./specialist-contract";

/** Subagents of one tester run (parallel cap; depth 1 = a subagent starts none): small, for independent reviews or test runs. */
const SUBAGENTS = { parallel: 2, depth: 1 };

/** The tester: Sonnet, writes and runs tests in its location (sandboxed shell). */
export const TESTER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  // + the Chrome DevTools browser tools (local MCP server, headless, a fresh profile in the run's scratch dir).
  mcpTools: [...SPECIALIST_BASE.mcpTools, ...BROWSER_TOOLS],
  name: "tester",
  noSubagents: false, // owner D7: the tester may spawn (tools limited by `subagentToolsFor`)
  subagents: SUBAGENTS,
  whenToUse:
    "Higher-level tests: integration, end-to-end, regression, edge and property cases; runs them, reports what breaks. A unit test of a change belongs to the developer.",
  sideEffects: "location",
  capabilities: ["read", "write", "shell", "skills"],
  skills: [
    METHOD_SKILL,
    "worker-reporting",
    "test-driven-development",
    "verification-before-completion",
    "systematic-debugging",
    "requesting-code-review",
    "property-based-testing",
    "test-master",
    "chrome-devtools",
  ],
  preloadSkills: [METHOD_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: ["verification-before-completion", "test-master"], // called before the first edit or command (named in one prompt line)
  promptSections: () =>
    testerContract({
      subagentsParallel: SUBAGENTS.parallel,
    }),
};

import {
  CHAIN_CAP,
  DELEGATE_MAX,
  DISPATCHES_PER_RUN,
  MAX_RUNNING_PER_THREAD,
} from "../../config/lead-caps";
import { ITEM_MAX_AGE_MS } from "../../config/resilience-caps";
import type { Location } from "../../locations/location-registry";
import { dispatchableWorkers } from "../role-registry";
import type { Capability, RoleDefinition } from "../role-types";

/** The item age limit in hours, for the prompt line. */
const ITEM_MAX_AGE_HOURS = ITEM_MAX_AGE_MS / 3_600_000;

/* TEAM.md: the lead's team, built by code per run from the role registry and the thread's locations (never a hand-kept
   list), so it is always true. Runtime facts only: strategies, events and what to do about them are the lead-orchestration skill's job; style,
   memory and privacy are the owner's (AGENTS.md). */

/** The one strategy fact code owns (a cap): the skill owns the strategies and when to pick which. */
const DELEGATE_LINE = `- DELEGATE: up to ${DELEGATE_MAX} workers as a chain: a task waits for at most one other, and no task is waited on by two. A bigger or branching shape is refused (NEEDS_PLAN).`;

/** Routing facts of the members section (static): who does work, and where lookups and research go. */
const ROUTING_LINE =
  "You route work and do not do it: work on a location's files or code, on the web, and every change is done by a member (dispatch it); do not search or read location files yourself. Your own tools cover memory, artifacts and this thread. A lookup in a location's code or files (where, how, which files, list, summarize) goes to the scout. A question about how a specific product, library, database, API or standard behaves (concurrency, limits, versions, prices), a paper, how others do something, or anything that must be verified or cited, goes to the researcher, not answered from your own knowledge.";

/** Member facts after the member lines: who can run commands and commit (from capabilities), the test split, owner contact. */
const memberFacts = (workers: readonly RoleDefinition[]): string[] => {
  const shell = workers.filter((r) => r.capabilities.includes("shell"));
  const commit = shell.filter((r) => r.capabilities.includes("write")).map((r) => r.name);
  return [
    shell.length
      ? `- Members with a shell can run commands and tests: ${shell.map((r) => r.name).join(", ")}; of these, only ${commit.join(", ") || "none"} can also change files, install and commit. A step that needs a command goes to a member with a shell; an install, a build that writes files or a commit goes to one that can also change files.`
      : "- No member has a shell: no item can run commands, tests or commits.",
    "- A unit test of a change belongs to the developer item that makes the change; higher-level tests (integration, end-to-end, regression, property) are the tester's.",
    "- Members have no owner contact except the developer's own questions; the others report questions in their result.",
  ];
};

/** Plain names of the capabilities a member has; internal ones (skills, tasks, mcp, feedback, ask, subagents) are left out. */
const TOOL_NAMES: Partial<Record<Capability, string>> = {
  read: "read files",
  write: "edit files",
  shell: "shell",
  web: "web",
};

/** One member line: name, what it is for, what it may touch and its tools. */
const memberLine = (r: RoleDefinition): string => {
  const tools = r.capabilities.map((c) => TOOL_NAMES[c]).filter(Boolean);
  return `- ${r.name}: ${r.whenToUse} [changes: ${r.sideEffects}; tools: ${tools.join(", ")}]`;
};

/** One location line: name, git flag and the owner's description (no path: the lead's reply is posted as is). */
const locationLine = (l: Location): string =>
  `- ${l.name}${l.git ? " [git]" : ""}${l.description ? `: ${l.description}` : ""}`;

/** What TEAM.md is built from. Both default to the live data; tests pass their own. */
export interface TeamMdInput {
  /** The dispatchable roles (default: the registry's). */
  workers?: readonly RoleDefinition[];
  /** The locations of the thread's channel: the only names a brief may use. */
  locations?: readonly Location[];
}

/** Build TEAM.md: members, locations, the delegate cap, limits. */
export function buildTeamMd(i: TeamMdInput = {}): string {
  const workers = i.workers ?? dispatchableWorkers();
  const locations = i.locations ?? [];
  return [
    "# TEAM",
    "Built by code for this run; the members and locations below are complete.",
    "",
    "## Members (role names for the dispatch tool)",
    ROUTING_LINE,
    ...(workers.length
      ? [...workers.map(memberLine), ...memberFacts(workers)]
      : ["- none available"]),
    "",
    "## Locations (the only names a brief may use)",
    ...(locations.length
      ? locations.map(locationLine)
      : ["- none in this channel: dispatch only work that needs no location"]),
    "",
    "## Strategies",
    DELEGATE_LINE,
    "",
    "## Limits (code enforces them; a refusal carries a code)",
    `- ${DISPATCHES_PER_RUN} dispatch or plan request per run; members start after your run ends. One open goal per thread.`,
    `- Up to ${MAX_RUNNING_PER_THREAD} items run at once (one writer per location); at most ${CHAIN_CAP} chained starts without a new owner message; an item older than ${ITEM_MAX_AGE_HOURS} h is held.`,
  ].join("\n");
}

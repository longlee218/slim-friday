import { REPORT_IMAGES_MAX } from "../../artifacts/artifact-limits";
import {
  CHAIN_CAP,
  DELEGATE_MAX,
  DISPATCHES_PER_RUN,
  MAX_RUNNING_PER_THREAD,
} from "../../config/lead-caps";
import { ITEM_MAX_AGE_MS } from "../../config/resilience-caps";
import type { Location } from "../../locations/location-registry";
import { PLAYWRIGHT_TOOLS } from "../../mcp/playwright/playwright-tool-names";
import { dispatchableWorkers } from "../role-registry";
import type { Capability, RoleDefinition } from "../role-types";

/** The item age limit in hours, for the prompt line. */
const ITEM_MAX_AGE_HOURS = ITEM_MAX_AGE_MS / 3_600_000;

/* TEAM.md: the lead's team, built by code per run from the role registry and the thread's locations (never a hand-kept
   list), so it is always true. Runtime facts only: strategies, events and what to do about them are the lead-orchestration skill's job; style,
   memory and privacy are the owner's (AGENTS.md). */

/** The one strategy fact code owns (a cap): the skill owns the strategies and when to pick which. */
const DELEGATE_LINE = `- DELEGATE: up to ${DELEGATE_MAX} workers as a chain: a task waits for at most one other, and no task is waited on by two. A bigger or branching shape is refused (NEEDS_PLAN).`;

/** The PLAN strategy fact: who staffs a plan (the skill owns when to pick it). */
const PLAN_LINE =
  "- PLAN: the planner writes the items and staffs them from the members above; the owner approves the plan once.";

/** Member facts after the table: who can install or commit, how a screenshot reaches the owner, who may ask the owner (all from role data). */
const memberFacts = (workers: readonly RoleDefinition[]): string[] => {
  const browser = workers.filter(hasBrowser);
  const askers = workers.filter((r) => r.capabilities.includes("ask")).map((r) => r.name);
  return [
    workers.some((r) => r.capabilities.includes("shell"))
      ? "- A command needs a member with shell; an install, a build that writes files or a commit needs one that also changes the location."
      : "- No member has a shell: no item can run commands, tests or commits.",
    ...(browser.length
      ? [
          `- A screenshot reaches the owner only when the member attaches it to its result (up to ${REPORT_IMAGES_MAX} png, jpeg or webp files): ask for "a screenshot attached to the result", not for a file path.`,
        ]
      : []),
    askers.length
      ? `- Only ${askers.join(", ")} can ask the owner (code relays it); the others report questions in their result.`
      : "- No member can ask the owner; members report questions in their result.",
  ];
};

/** The member has every Playwright browser tool (open a page, take a screenshot). */
const hasBrowser = (r: RoleDefinition): boolean =>
  PLAYWRIGHT_TOOLS.every((t) => r.mcpTools?.includes(t));

/** Plain names of the capabilities a member has; internal ones (skills, tasks, mcp, review, feedback, ask, subagents) are left out. */
const TOOL_NAMES: Partial<Record<Capability, string>> = {
  read: "read",
  write: "edit",
  shell: "shell",
  web: "web",
};

/** A table cell: one line, no pipe (a pipe would split the cell). */
const cell = (t: string | undefined): string =>
  (t || "-").replace(/\|/g, "/").replace(/\s+/g, " ").trim();

/** The members table: routing is role data (Use when, Not for), so a new role needs no prompt text. */
const memberTable = (workers: readonly RoleDefinition[]): string[] => [
  "| Role | Use when | Not for | Changes | Tools |",
  "|---|---|---|---|---|",
  ...workers.map((r) => {
    const tools = [
      ...r.capabilities.map((c) => TOOL_NAMES[c]).filter(Boolean),
      ...(hasBrowser(r) ? ["browser"] : []),
    ];
    return `| ${r.name} | ${cell(r.whenToUse)} | ${cell(r.notFor)} | ${r.sideEffects} | ${tools.join(", ")} |`;
  }),
];

/** One location line: name, git flag and the owner's description (no path: the lead's reply is posted as is). */
const locationLine = (l: Location): string =>
  `- ${l.name}${l.git ? " [git]" : ""}${l.description ? `: ${l.description}` : ""}`;

/** What TEAM.md is built from. Both default to the live data; tests pass their own. */
export interface TeamMdInput {
  /** The dispatchable roles (default: the registry's). */
  workers?: readonly RoleDefinition[];
  /** The locations of the thread's channel: the only names a brief may use. */
  locations?: readonly Location[];
  /** Replaces the Locations list with this line (the home-level snapshot has no channel, so no locations). */
  locationsNote?: string;
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
    ...(workers.length ? [...memberTable(workers), ...memberFacts(workers)] : ["- none available"]),
    "",
    "## Locations (the only names a brief may use)",
    ...(i.locationsNote
      ? [i.locationsNote]
      : locations.length
        ? locations.map(locationLine)
        : ["- none in this channel: dispatch only work that needs no location"]),
    "",
    "## Strategies",
    DELEGATE_LINE,
    PLAN_LINE,
    "",
    "## Limits (code enforces them; a refusal carries a code)",
    `- ${DISPATCHES_PER_RUN} dispatch or plan request per run; members start after your run ends. One open goal per thread.`,
    `- Up to ${MAX_RUNNING_PER_THREAD} items run at once (one writer per location); at most ${CHAIN_CAP} chained starts without a new owner message; an item older than ${ITEM_MAX_AGE_HOURS} h is held.`,
  ].join("\n");
}

import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one humanizer-writer run. */
const BUDGET_USD = 1.5;

/** What this specialist does, after the shared contract. */
const JOB = `Built-in role: writer. Does: writes or edits the document the brief names, in the location, in clear natural prose for its reader; reports its path. Uses only the brief, the files and the earlier results: no invented facts.`;

/** The humanizer-writer: Haiku, writes and edits documents in its location. */
export const HUMANIZER_WRITER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "humanizer-writer",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Prose for people: docs, README, release notes, posts, emails; writes or edits documents in a natural voice from the facts in the brief and earlier results.",
  sideEffects: "location",
  capabilities: ["read", "write", "skills"],
  skills: ["worker-reporting"],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};

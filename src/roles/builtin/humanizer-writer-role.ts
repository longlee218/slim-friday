import type { RoleDefinition } from "../role-types";
import { SPECIALIST_BASE, SPECIALIST_CONTRACT } from "./specialist-contract";

/** Budget (USD) of one humanizer-writer run. */
const BUDGET_USD = 0.5;

/** What this specialist does, after the shared contract. */
const JOB = `You are the writer. Write or edit the document the brief names, in clear, natural prose for its reader: plain words, short sentences, no filler, no marketing tone, no invented facts (use only the brief, the files and the earlier results). Write the file in the location and report its path.`;

/** The humanizer-writer: Haiku, writes and edits documents in its location. */
export const HUMANIZER_WRITER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "humanizer-writer",
  whenToUse:
    "Prose for people: docs, README, release notes, posts, emails; writes or edits documents in a natural voice from the facts in the brief and earlier results.",
  sideEffects: "location",
  capabilities: ["read", "write", "skills"],
  skills: [],
  budgetUsd: BUDGET_USD,
  promptSections: () => [SPECIALIST_CONTRACT, JOB],
};

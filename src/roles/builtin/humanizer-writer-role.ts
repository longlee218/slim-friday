import { humanizerWriterContract } from "../prompts/contracts/humanizer-writer-contract";
import type { RoleDefinition } from "../role-types";
import { METHOD_SKILL, SPECIALIST_BASE } from "./specialist-contract";

/** The humanizer-writer: Sonnet, writes and edits documents in its location. */
export const HUMANIZER_WRITER_ROLE: RoleDefinition = {
  ...SPECIALIST_BASE,
  mcpTools: [...SPECIALIST_BASE.mcpTools],
  name: "humanizer-writer",
  basePrompt: "custom", // writes no code: no SDK coding preset
  whenToUse:
    "Prose for people: docs, README, release notes, posts, emails; writes or edits documents in a natural voice from the facts in the brief and earlier results.",
  notFor: "Code.",
  sideEffects: "location",
  capabilities: ["read", "write", "skills"],
  skills: [
    METHOD_SKILL,
    "worker-reporting",
    "verification-before-completion",
    "technical-writing",
    "reviewing-technical-prose",
    "writing-changelogs",
    "recording-decisions",
  ],
  preloadSkills: [METHOD_SKILL], // the rule to check skills first is in the system prompt
  requiredSkills: ["technical-writing", "verification-before-completion"], // called before the first edit or command (named in one prompt line)
  promptSections: () => humanizerWriterContract(),
};

import type { RoleKey } from "./chat-types";

/** Canned answer per role for the fixture runtime. */
export const REPLY: Record<RoleKey, string> = {
  lead: "On it. I will come back only if a decision is needed.",
  developer: "Sure. Failing test first, then the fix.",
  tester: "I will reproduce it and send exact steps.",
  researcher: "Searching now. Every claim gets a source.",
  designer: "Two options coming, both calm.",
  writer: "Drafting now, in your voice.",
  devops: "Checking the deploy first.",
  security: "Scanning for leaks first.",
};

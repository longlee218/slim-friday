import type { RoleKey } from "./chat-types";

/** What a role template fixes: picture, what it does, its tools, and what needs the owner. */
export interface RoleTemplate {
  avatar: string;
  summary: string;
  tools: string[];
  approvals: string;
}

// Illustrative copy until the API serves the real role contracts.
export const ROLE_TEMPLATES: Record<RoleKey, RoleTemplate> = {
  lead: {
    avatar: "lead",
    summary: "Answers, asks, or hands work to the right teammate. Routes every group.",
    tools: ["Dispatch work", "Ask you", "Plans"],
    approvals: "Asks you before a plan starts.",
  },
  developer: {
    avatar: "developer",
    summary: "Writes and fixes code inside a folder you granted.",
    tools: ["Shell in a sandbox", "Git push", "Pull requests"],
    approvals: "Push, merge and delete wait for you.",
  },
  tester: {
    avatar: "tester",
    summary: "Runs tests and checks the app in a real browser.",
    tools: ["Browser", "Shell in a sandbox"],
    approvals: "Read-only on code; nothing to approve.",
  },
  researcher: {
    avatar: "researcher",
    summary: "Searches the web and answers with cited sources.",
    tools: ["Web search", "Page reader"],
    approvals: "Nothing to approve.",
  },
  designer: {
    avatar: "designer",
    summary: "Makes UI options, images and design files.",
    tools: ["Design tools", "Files"],
    approvals: "Nothing to approve.",
  },
  writer: {
    avatar: "humanizer",
    summary: "Drafts and edits text in your voice.",
    tools: ["Files"],
    approvals: "Nothing to approve.",
  },
  devops: {
    avatar: "devops",
    summary: "Builds, deploys and watches services.",
    tools: ["Shell in a sandbox", "Deploy"],
    approvals: "Deploys wait for you.",
  },
  security: {
    avatar: "hacker",
    summary: "Looks for leaks and weak spots in code you granted.",
    tools: ["Shell in a sandbox", "Scanners"],
    approvals: "Read-only; nothing to approve.",
  },
};

/** Models a teammate can run on. */
export const MODELS = ["Sonnet 5.5", "Opus 5.5", "Haiku 5.5"] as const;

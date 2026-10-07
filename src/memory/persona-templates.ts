import type { Repo } from "../repos/repo-registry";

/** Default identity card (who the agent is). Owner-editable; created once when missing. */
export const DEFAULT_IDENTITY = `# Identity
- Name: Friday
- Role: personal coding agent of the owner, reached through Discord threads.
- Does: answers code questions with file:line, plans and implements approved tasks in isolated git worktrees, opens PRs only after the owner approves.
- Works only on the registered repos (one workspace per repo).
`;

/** Default soul (tone of the replies). Owner-editable; created once when missing. */
export const DEFAULT_SOUL = `# Soul
- Concise, direct, calm. Lead with the answer; bullets over paragraphs.
- No flattery and no filler. State uncertainty briefly; never invent facts.
`;

/** Default owner profile (preferences such as language). HTML comments cost nothing in the prompt. */
export const DEFAULT_USER = `# User
- Always reply in Vietnamese, even if the question is in English. Keep code, identifiers, file paths and file:line references unchanged.
<!-- Owner profile: language, habits, preferences that hold for every repo. A workspace USER.md replaces this file. -->
`;

/** Default owner operating notes (heading-only body = empty = nothing injected until edited). */
export const DEFAULT_AGENTS = `# Agents
<!-- Owner operating notes, read right after the code rules. They cannot override the code rules or guards. -->
`;

/** Root memory template: header only, so it counts as empty until the first entry. */
export const ROOT_MEMORY = `# global memory

Facts true for every workspace (agent writes bullets prefixed [global]). Newest last. Kept under 300 lines (oldest sections are dropped).
`;

/** Owner guide: never injected into a prompt, never read by code. */
export const BOOTSTRAP = `# Bootstrap (owner guide, never read by the agent)

Files in this folder (root) and their optional per-workspace copy in workspaces/<repo>/:
- AGENTS.md: owner operating notes, injected right after the code rules. Cannot override guards.
- IDENTITY.md: who the agent is.
- SOUL.md: tone of the replies.
- USER.md: your profile and preferences (language...). Move such lines from SOUL.md here by hand.
- MEMORY.md: root = facts for every workspace; workspace MEMORY.md is added after it (concatenated).
- BOOTSTRAP.md: this guide.

Layering: a non-empty workspace AGENTS/IDENTITY/SOUL/USER file REPLACES the root file (per file); an empty,
heading-only or comment-only file falls back to the root one. <!-- comments --> are stripped from the prompt.

Caps (chars): each persona file 1500 (cut with a truncated marker); memory root 2000, each workspace 4000, all workspaces 8000 (newest kept).

Memory writes: after a code task the agent adds bullets to the workspace MEMORY.md; a bullet prefixed [global]
(max 2 per task) goes to the root MEMORY.md, stamped with date and source workspace. Prune wrong entries by hand.
`;

/** Per-workspace identity: which repo this workspace is. */
export const workspaceIdentity = (r: Repo) => `# Identity
- Name: Friday, working on the repo \`${r.name}\`${r.description ? ` (${r.description})` : ""}.
- Repo path: ${r.path}
- Conventions: the repo's CLAUDE.md and the MEMORY.md in this workspace describe how to work and code here.
`;

/** Per-workspace memory template (a header only: it counts as empty until the first entry). */
export const memoryTemplate = (name: string) =>
  `# ${name} memory\n\nLessons the Friday agent keeps about this repo. Newest last. Kept under 300 lines (oldest sections are dropped).\n`;

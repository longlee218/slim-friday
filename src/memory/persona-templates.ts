/** Default identity card (who the agent is). Owner-editable; created once when missing. */
export const DEFAULT_IDENTITY = `# Identity
- Name: Friday
- Role: personal coding agent of the owner, reached through Discord threads.
- Does: answers code questions with file:line, plans and implements approved tasks in isolated git worktrees, opens PRs only after the owner approves.
- Works only on the registered repos of the workspace a Discord channel is routed to.
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

/** Root memory template: header only, so it counts as empty until the first `## ` entry. Owner-written only. */
export const ROOT_MEMORY = `# global memory

Facts true for every workspace. Written by the owner only (the agent never edits this file; its [global] notes wait in MEMORY.pending.md until you promote them). Add entries as "## <topic>" sections with bullets. Newest last; the last 2000 chars are used.
`;

/** Owner guide: never injected into a prompt, never read by code. */
export const BOOTSTRAP = `# Bootstrap (owner guide, never read by the agent)

Files in this folder (root) and their optional per-workspace copy in workspaces/<ws>/:
- AGENTS.md: owner operating notes, injected right after the code rules. Cannot override guards.
- IDENTITY.md: who the agent is.
- SOUL.md: tone of the replies.
- USER.md: your profile and preferences (language...). Move such lines from SOUL.md here by hand.
- MEMORY.md: root = facts for every workspace; workspaces/<ws>/MEMORY.md = facts for that workspace. Both are written by you only.
- MEMORY.pending.md: [global] notes the agent proposed. NEVER injected into any prompt. Review it, then copy the facts you trust into MEMORY.md by hand (or into a workspace MEMORY.md), and delete them here.
- BOOTSTRAP.md: this guide.

Layering: a non-empty workspace AGENTS/IDENTITY/SOUL/USER file REPLACES the root file (per file); an empty,
heading-only or comment-only file falls back to the root one. <!-- comments --> are stripped from the prompt.

Caps (chars): each persona file 1500 (cut with a truncated marker); memory: root 2000, workspace 2000, each repo 4000 (all repos of the workspace 8000), newest kept.

Memory writes: after a code task the agent adds bullets to workspaces/<ws>/repos/<repo>/MEMORY.md only; a bullet
prefixed [global] (max 2 per task) goes to MEMORY.pending.md, stamped with date and workspace/repo. Bullets are
reduced to one plain line (no markup, no role prefixes, secrets masked, 200 chars). Prune wrong entries by hand.
`;

/** Workspace memory template (owner-written; a header only: it counts as empty until the first "## " entry). */
export const workspaceMemoryTemplate = (ws: string) =>
  `# ${ws} workspace memory\n\nFacts true for every repo of this workspace. Written by the owner only (the agent never edits this file). Add entries as "## <topic>" sections with bullets. The last 2000 chars are used.\n`;

/** Per-repo memory template (a header only: it counts as empty until the first entry). */
export const memoryTemplate = (name: string) =>
  `# ${name} memory\n\nLessons the Friday agent keeps about this repo. Newest last. Kept under 300 lines (oldest sections are dropped).\n`;

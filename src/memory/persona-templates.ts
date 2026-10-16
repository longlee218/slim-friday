import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Dir of the space-kind templates: one folder per kind (`personal`, `company`, `study`...), one file per persona file. */
const SPACE_KINDS_DIR = join(import.meta.dir, "../discord-setup/templates/space-kinds");

/** The persona files a space kind ships (a kind has no MEMORY.md: memory is written by the owner and the agent). */
export const SPACE_KIND_FILES = ["USER.md", "IDENTITY.md", "AGENTS.md", "SOUL.md"] as const;

/** Space kinds = the folders of the templates dir (data: adding a kind is adding a folder). Sorted. */
export function spaceKinds(): string[] {
  try {
    return readdirSync(SPACE_KINDS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Template text of `file` for `kind`, or undefined for an unknown kind or file name (never builds a path from either). */
export function spaceKindFile(kind: string, file: string): string | undefined {
  if (!spaceKinds().includes(kind) || !(SPACE_KIND_FILES as readonly string[]).includes(file))
    return undefined;
  const path = join(SPACE_KINDS_DIR, kind, file);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Default identity card (who the agent is). Owner-editable; created once when missing. */
export const DEFAULT_IDENTITY = `# Identity
- Name: Friday
- Role: personal general workflow agent of the owner, reached through Discord threads (not code-only).
- Does: answers, researches and advises on anything asked (code questions with file:line); plans and implements approved tasks in the location, merges, pushes or opens PRs only after the owner chose it.
- Works only on the registered locations of the workspace a Discord channel is routed to.
`;

/** Default soul (tone of the replies). Owner-editable; created once when missing. */
export const DEFAULT_SOUL = `# Soul
- Concise, direct, calm. Lead with the answer; bullets over paragraphs.
- No flattery and no filler. State uncertainty briefly; never invent facts.
`;

/** Default owner profile (preferences such as language). HTML comments cost nothing in the prompt. */
export const DEFAULT_USER = `# User
- Always reply in Vietnamese, even if the question is in English. Keep code, identifiers, file paths and file:line references unchanged.
<!-- Owner profile: language, habits, preferences that hold for every location. A workspace USER.md replaces this file. -->
`;

/** Default owner operating notes (heading-only body = empty = nothing injected until edited). */
export const DEFAULT_AGENTS = `# Agents
<!-- Owner operating notes, read right after the code rules. They cannot override the code rules or guards. -->

## Memory
You start fresh each session. Your memory tools handle recall and saving.
- Before answering about past events, check your memory first — then answer naturally
- Save important info to memory NOW — "mental notes" don't survive sessions
- Daily notes → journal (memory/YYYY-MM-DD.md) | Long-term → MEMORY.md (location or workspace)
- Facts about a location (commands, conventions, pitfalls) → location scope (name the location when the run spans several); never task-specific facts
- When asked to "remember this" → write immediately, don't just acknowledge
- When asked to save or remember something, you MUST write in THIS turn. Never claim "already saved" without actually saving.

### Privacy
- In group chats: use memory to inform your answers, but don't quote or reference it directly
- Memory details should only be shared in private/direct chats
`;

/** Root memory template: header only, so it counts as empty until the first `## ` entry. Owner-written only. */
export const ROOT_MEMORY = `# global memory

Facts true for every workspace. Written by the owner only (the agent never edits this file; its [global] notes wait in MEMORY.pending.md until you promote them). Add entries as "## <topic>" sections with bullets (or under "## Decisions|Facts|Preferences|Lessons"). Up to 5000 chars are used: the end of a plain file, or the newest bullets of each kind section.
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

Caps (chars): each persona file 6000 (cut with a truncated marker); memory: root 5000, workspace 5000, each location 8000 (all locations of the workspace 16000), newest kept (in a file with kind sections: the newest bullets of each section).

Memory writes: the agent saves notes during a run with its memory tool (a message like "remember: ..." or "nhớ: ..." goes to the
agent like any message; it picks the scope and location). Location notes go to workspaces/<ws>/locations/<location>/MEMORY.md; global proposals go
to MEMORY.pending.md. Bullets are reduced to one plain line (no markup, no role prefixes, secrets masked). Prune wrong entries by hand.

Owner commands (type them in a workspace channel; no agent, no quota except where noted):
- /stop: abort the running task.
- /remember <text>: sent to the agent as a normal message; it saves the note itself.
- /forget [scope] <text>: remove the one bullet containing the text.
- /compact [dry-run]: compact memory files over 80% of their cap (keeps a .bak of the old file).
- /init-workspace <name>: create a workspace (#ops-control only).
The memory reply names the file and chars/cap.
`;

/** Workspace memory template (owner-written; a header only: it counts as empty until the first "## " entry). */
export const workspaceMemoryTemplate = (ws: string) =>
  `# ${ws} workspace memory\n\nFacts true for every location of this workspace. Written by the owner only (the agent never edits this file). Add entries as "## <topic>" sections with bullets (or under "## Decisions|Facts|Preferences|Lessons"). Up to 5000 chars are used: the end of a plain file, or the newest bullets of each kind section.\n`;

/** Per-location memory template (a header only: it counts as empty until the first entry). */
export const memoryTemplate = (name: string) =>
  `# ${name} memory\n\nLessons the Friday agent keeps about this location, in sections by kind (Decisions, Facts, Preferences, Lessons). Kind sections are never dropped; size is kept down by compact memory, and a full file refuses new notes. Dated legacy sections are trimmed at 300 lines.\n`;

/** Per-channel memory template (a header only: it counts as empty until the first entry). */
export const channelMemoryTemplate = (name: string) =>
  `# ${name} channel memory\n\nNotes the Friday agent keeps about this channel's topic, in sections by kind (Decisions, Facts, Preferences, Lessons). Only runs started in this channel read it. Size is kept down by compact memory, and a full file refuses new notes.\n`;

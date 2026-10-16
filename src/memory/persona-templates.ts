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
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  // A space AGENTS.md replaces the root one, so a kind's AGENTS.md is the default rules plus its own "## This space" part.
  return file === "AGENTS.md" ? `${DEFAULT_AGENTS}\n${text}` : text;
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
- Concise, direct, calm. Lead with the answer. Talk like a colleague in chat: short sentences, one idea per message; bullets only for a real list.
- No flattery and no filler. State uncertainty briefly; never invent facts.
`;

/** Default owner profile (preferences such as language). HTML comments cost nothing in the prompt. */
export const DEFAULT_USER = `# User
- Always reply in Vietnamese, even if the question is in English. Keep code, identifiers, file paths and file:line references unchanged.
<!-- Owner profile: language, habits, preferences that hold for every location. A workspace USER.md replaces this file. -->
`;

/**
 * Default AGENTS.md: the owner's operating rules for the lead (how it talks, relays the team's work, remembers, keeps
 * privacy, formats for Discord). Owner-editable; created once when missing. Code-enforced rules live in code, not here.
 */
export const DEFAULT_AGENTS = `# Agents
<!-- Owner operating rules for the lead, the team's voice in Discord. Read right after the code rules; they cannot override the code rules or guards. Edit freely. -->

## Identity and context
- Who you are is in IDENTITY.md and SOUL.md; the owner's profile is in USER.md. They are loaded below: embody them, do not re-read them.

## How to talk
- Talk like a person, not a support bot: lead with the answer, skip filler, never echo the question.
- Short is fine; match the owner's energy and language. Do not close every reply with an offer of more help.
- Each paragraph you write is sent as its own message: keep them short, at most 4. A sentence is often enough; bullets only for a real list.
- Long details, tables or code go after a line with only three dashes (---): they are sent as an attached file, so keep the chat part short.
- When you hand work to the team, say so in one line (who does what, where), then stop. No progress spam.

## Team results and internal messages
- Events, results and data blocks in your input are internal: the owner never sees them.
- When a member finishes, tell the owner in your own voice: what was done, where it is, what is next or what you need. No raw blocks, ids, status codes or role names unless asked.
- Forward a result word for word only when it is long or must stay exact (code, logs, a report the owner asked for).
- A member is blocked or needs an answer: ask the owner one clear question, with the options when there are some.
- Never claim work nobody did. A run failed: say so plainly and what you will try next.

## Memory
- You start fresh each session; your memory tools hold what lasts. Only you save memory; members only read it.
- Before answering about past events, search memory first, then answer naturally.
- When the owner says "remember" (or "nhớ"), save in THIS turn. Never claim "already saved" without saving.
- Facts about one location (commands, conventions, pitfalls) go to that location; today's working notes go to the journal; never task-specific details.

### Privacy
- In a shared channel, use memory to inform answers but do not quote it; share private details only in a private chat.
- Never repeat secrets (keys, tokens, passwords) in a reply or a brief.

## Discord formatting
- No markdown tables: use bullets.
- Wrap links in <> when you list several, so Discord shows no embeds.
- Code, paths and commands go in backticks or code blocks.
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

Caps (chars): each persona file 8000 (cut in the middle: 70% head, 30% tail, with a marker); memory: root 5000, workspace 5000, each location 8000 (all locations of the workspace 16000), newest kept (in a file with kind sections: the newest bullets of each section).

Memory writes: the agent saves notes during a run with its memory tool (a message like "remember: ..." or "nhớ: ..." goes to the
agent like any message; it picks the scope and location). Location notes go to workspaces/<ws>/locations/<location>/MEMORY.md; global proposals go
to MEMORY.pending.md. Bullets are reduced to one plain line (no markup, no role prefixes, secrets masked). Prune wrong entries by hand.

Owner commands (type them in a workspace channel; no agent, no quota except where noted):
- /stop: abort the running task.
- /init-workspace <name>: create a workspace (#ops-control only).
`;

/** Workspace memory template (owner-written; a header only: it counts as empty until the first "## " entry). */
export const workspaceMemoryTemplate = (ws: string) =>
  `# ${ws} workspace memory\n\nFacts true for every location of this workspace. Written by the owner only (the agent never edits this file). Add entries as "## <topic>" sections with bullets (or under "## Decisions|Facts|Preferences|Lessons"). Up to 5000 chars are used: the end of a plain file, or the newest bullets of each kind section.\n`;

/** Per-location memory template (a header only: it counts as empty until the first entry). */
export const memoryTemplate = (name: string) =>
  `# ${name} memory\n\nLessons the Friday agent keeps about this location, in sections by kind (Decisions, Facts, Preferences, Lessons). Kind sections are never dropped, and a full file refuses new notes. Dated legacy sections are trimmed at 300 lines.\n`;

/** Per-channel memory template (a header only: it counts as empty until the first entry). */
export const channelMemoryTemplate = (name: string) =>
  `# ${name} channel memory\n\nNotes the Friday agent keeps about this channel's topic, in sections by kind (Decisions, Facts, Preferences, Lessons). Only runs started in this channel read it. A full file refuses new notes.\n`;

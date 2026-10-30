import { MEMORY_LABEL } from "../hub/memory-label";
import { RULES_LABEL } from "../hub/rules-label";
import { EMPTY_SCRATCHPAD_BLOCK } from "../hub/scratchpad-block";
import type { BotRuntimeSpec } from "../ports/agent-runtime";

/** A part of the session state a bot is shown (and can go stale in a resumed session). */
export type StatePart =
  | "rules"
  | "memory"
  | "groupContext"
  | "groupRules"
  | "groupMemory"
  | "teammates"
  | "scratchpad";

/** Hash of each state part as last shown to a session; a missing part was never shown. */
export type SessionStateHashes = Partial<Record<StatePart, string>>;

/** The text of each state part; a part that is not shown is "". */
export type StateTexts = Partial<Record<StatePart, string>>;

/** Heading and label of each part as the system prompt shows it; the scratchpad is its own block. */
const SECTIONS: Record<Exclude<StatePart, "scratchpad">, { heading: string; label?: string }> = {
  rules: { heading: "Your rules", label: RULES_LABEL },
  memory: { heading: "Your memory", label: MEMORY_LABEL },
  groupContext: { heading: "Group context" },
  groupRules: { heading: "Group rules", label: RULES_LABEL },
  groupMemory: { heading: "Group memory", label: MEMORY_LABEL },
  teammates: { heading: "Teammates" },
};

/** Parts in system prompt order. */
const ORDER: StatePart[] = [
  "rules",
  "memory",
  "groupContext",
  "groupRules",
  "groupMemory",
  "teammates",
  "scratchpad",
];

const EMPTY = "(now empty)";
const HEAD =
  "<state_changed>\nSince this session started, Friday updated these parts of your instructions. They replace the earlier copies.";
const TAIL = "</state_changed>";

/**
 * The text each state part has in the system prompt of `spec` ("" when not shown). The teammate directory is a
 * part of a direct session only (a group session's roster is in its group context).
 */
export function stateParts(spec: BotRuntimeSpec): StateTexts {
  return {
    rules: spec.rules ?? "",
    memory: spec.memory ?? "",
    groupContext: spec.groupContext ?? "",
    groupRules: spec.groupRules ?? "",
    groupMemory: spec.groupMemory ?? "",
    ...(!spec.groupId && { teammates: spec.teammates ?? "" }),
    scratchpad: spec.scratchpad ?? "",
  };
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit of the UTF-8 bytes of `s`, as 16 hex digits (no node modules in core). */
function fnv1a64(s: string): string {
  let h = FNV_OFFSET;
  for (const b of new TextEncoder().encode(s)) h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK_64;
  return h.toString(16).padStart(16, "0");
}

/**
 * The hash of each part (FNV-1a 64-bit hex); an empty part hashes to "". A collision only costs a missed
 * refresh until the part changes again.
 */
export function stateHashes(parts: StateTexts): SessionStateHashes {
  const out: SessionStateHashes = {};
  for (const p of ORDER) {
    const text = parts[p];
    if (text !== undefined) out[p] = text ? fnv1a64(text) : "";
  }
  return out;
}

/** One part's section of the block, headed and labelled as in the system prompt. */
function sectionOf(part: StatePart, text: string): string {
  if (part === "scratchpad") return text || EMPTY_SCRATCHPAD_BLOCK;
  const { heading, label } = SECTIONS[part];
  return `## ${heading}\n${label ? `${label}\n\n` : ""}${text || EMPTY}`;
}

/**
 * The `<state_changed>` block of the parts whose hash differs from `seen` (a part never seen counts as empty),
 * leaving out the parts in `skip`; undefined when nothing changed. An emptied part reads "(now empty)".
 */
export function stateChangedBlock(
  parts: StateTexts,
  seen: SessionStateHashes,
  skip: StatePart[],
): { text: string; changed: StatePart[] } | undefined {
  const now = stateHashes(parts);
  const changed = ORDER.filter(
    (p) => now[p] !== undefined && !skip.includes(p) && now[p] !== (seen[p] ?? ""),
  );
  if (changed.length === 0) return undefined;
  const sections = changed.map((p) => sectionOf(p, parts[p] ?? ""));
  return { text: `${HEAD}\n${sections.join("\n\n")}\n${TAIL}`, changed };
}

/** The hashes to store after a resume: the new ones, but a part in `skip` keeps what `seen` had. */
export function nextStateHashes(
  parts: StateTexts,
  seen: SessionStateHashes,
  skip: StatePart[],
): SessionStateHashes {
  const out = stateHashes(parts);
  for (const p of skip) {
    if (seen[p] === undefined) delete out[p];
    else out[p] = seen[p];
  }
  return out;
}

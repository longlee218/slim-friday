import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AdminError, type MemoryOwner, RULE_MAX_CHARS, RULES_MAX, type Rule } from "@friday/core";
import { ownerDir } from "./file-memory";
import { MemoryBusyError, withMemoryLock, writeAtomic } from "./memory-file-lock";
import { sanitizeBullet } from "./sanitize-bullet";

/** A rule line: `- [x] text` (on) or `- [ ] text` (off). */
const RULE_LINE = /^- \[([ xX])\] (.*)$/;

/** Path of the owner's RULES.md (next to MEMORY.md). */
const rulesFile = (root: string, owner: MemoryOwner): string =>
  join(ownerDir(root, owner), "RULES.md");

/** The rules of a RULES.md text, in line order; lines that are not rule lines are ignored. */
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = RULE_LINE.exec(line);
    if (m?.[2]?.trim()) rules.push({ text: m[2].trim(), on: m[1] !== " " });
  }
  return rules;
}

/** The RULES.md text of a rule list: a heading, then one checklist line per rule. */
export const renderRules = (rules: Rule[]): string =>
  `# Rules\n\n${rules.map((r) => `- [${r.on ? "x" : " "}] ${r.text}\n`).join("")}`;

/** The owner's rules; none when the file does not exist. */
export function readRules(root: string, owner: MemoryOwner): Rule[] {
  const file = rulesFile(root, owner);
  return existsSync(file) ? parseRules(readFileSync(file, "utf8")) : [];
}

/** A rule cleaned for the file; refused (never cut) when empty, multi-line or too long. */
function cleanRule(rule: Rule): Rule {
  const bad = (m: string) => new AdminError("BAD_REQUEST", m, "rules");
  if (/[\r\n]/.test(rule.text)) throw bad("a rule is one line");
  const text = sanitizeBullet(rule.text, Number.POSITIVE_INFINITY);
  if (!text) throw bad("a rule cannot be empty");
  if (text.length > RULE_MAX_CHARS) throw bad(`a rule is at most ${RULE_MAX_CHARS} characters`);
  return { text, on: rule.on };
}

/**
 * Replace the owner's rules. Every rule is checked first, so a refusal leaves the file as it was; the write runs
 * under the file lock and is atomic (a busy lock is a CONFLICT).
 */
export function writeRules(root: string, owner: MemoryOwner, rules: Rule[]): void {
  if (rules.length > RULES_MAX)
    throw new AdminError("BAD_REQUEST", `at most ${RULES_MAX} rules`, "rules");
  const text = renderRules(rules.map(cleanRule));
  const dir = ownerDir(root, owner);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "RULES.md");
  try {
    withMemoryLock(file, () => writeAtomic(file, text));
  } catch (err) {
    if (err instanceof MemoryBusyError) throw new AdminError("CONFLICT", "rules are being written");
    throw err;
  }
}

/** The on rules as `- <text>` lines for a prompt; "" when none is on. */
export const rulesForPrompt = (rules: Rule[]): string =>
  rules
    .filter((r) => r.on)
    .map((r) => `- ${r.text}`)
    .join("\n");

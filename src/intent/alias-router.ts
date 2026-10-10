import type { RoleDefinition } from "../roles/role-types";
import { tokenizeMessage, tokenizePhrase } from "./normalize-text";
import { matchesPhrase } from "./phrase-matcher";

/** How the role was chosen. */
export type AliasVia = "prefix" | "strong" | "weak";

/** L3 outcome: one role decided, or undecided (none or several matched: L4 / ask later). */
export type AliasDecision =
  | { decided: true; role: string; via: AliasVia; ruleIds: string[] }
  | { decided: false; roles: string[]; ruleIds: string[] };

export interface AliasRouter {
  /** `idle`: the thread has no running task or gate (weak aliases only count then). */
  route(text: string, idle: boolean): AliasDecision;
}

/** The part of a role the router needs. */
type AliasRole = Pick<RoleDefinition, "name" | "aliases">;

interface Compiled {
  name: string;
  tag?: string;
  strong: string[][];
  weak: string[][];
}

/** Thread states with no task in flight (same meaning as `isIdleLike` in thread-state; kept local so intent stays import-light). */
export const isIdleState = (state: string): boolean => state === "idle" || state === "done";

/**
 * Compile the role aliases. Registry validation, throws when: a tag is malformed or used by two roles, or the
 * same STRONG phrase (normalized) is declared by two roles (it could never route to exactly one).
 */
export function createAliasRouter(roles: readonly AliasRole[]): AliasRouter {
  const compiled: Compiled[] = [];
  const tagOwner = new Map<string, string>();
  const strongOwner = new Map<string, string>();
  for (const r of roles) {
    if (!r.aliases) continue;
    const tag = r.aliases.tag.toLowerCase();
    if (!/^\[[a-z0-9_-]+\]$/.test(tag))
      throw new Error(`Role ${r.name}: invalid alias tag "${r.aliases.tag}"`);
    const tagBy = tagOwner.get(tag);
    if (tagBy) throw new Error(`Alias tag ${tag} is used by roles ${tagBy} and ${r.name}`);
    tagOwner.set(tag, r.name);
    const strong = r.aliases.strong.map(tokenizePhrase);
    for (const p of strong) {
      const key = p.join(" ");
      const by = strongOwner.get(key);
      if (by && by !== r.name)
        throw new Error(`Alias "${key}" is a strong alias of roles ${by} and ${r.name}`);
      strongOwner.set(key, r.name);
    }
    compiled.push({ name: r.name, tag, strong, weak: (r.aliases.weak ?? []).map(tokenizePhrase) });
  }

  return {
    route(text, idle) {
      // A prefix tag always wins.
      const head = text.normalize("NFC").trim().toLowerCase();
      const tagged = compiled.find((c) => c.tag && head.startsWith(c.tag));
      if (tagged) {
        return {
          decided: true,
          role: tagged.name,
          via: "prefix",
          ruleIds: [`alias:${tagged.name}:prefix`],
        };
      }
      // Otherwise: roles with a strong hit, plus weak hits on an idle thread. Exactly one role = decided.
      const tokens = tokenizeMessage(text);
      const hits: { role: string; via: AliasVia }[] = [];
      for (const c of compiled) {
        if (c.strong.some((p) => matchesPhrase(tokens, p)))
          hits.push({ role: c.name, via: "strong" });
        else if (idle && c.weak.some((p) => matchesPhrase(tokens, p)))
          hits.push({ role: c.name, via: "weak" });
      }
      const ruleIds = hits.map((h) => `alias:${h.role}:${h.via}`);
      const only = hits[0];
      if (hits.length === 1 && only)
        return { decided: true, role: only.role, via: only.via, ruleIds };
      return { decided: false, roles: hits.map((h) => h.role), ruleIds };
    },
  };
}

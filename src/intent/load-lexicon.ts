import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type GroupEffect, lexiconFileSchema } from "./lexicon-schema";
import { tokenizePhrase } from "./normalize-text";

/** A group with its phrases already normalized to tokens (the file keeps diacritics). */
export interface CompiledGroup {
  id: string;
  effect: GroupEffect;
  phrases: string[][];
  weak: string[][];
}

/** The lexicon the pipeline uses: groups in a stable order (default order, new override groups last). */
export interface CompiledLexicon {
  groups: CompiledGroup[];
}

/** Shipped default; the owner may override per group in `<AGENT_HOME>/intent-lexicon.yaml`. */
export const DEFAULT_LEXICON_FILE = join(import.meta.dir, "data", "intent-lexicon.yaml");
export const lexiconOverrideFile = (agentHome: string): string =>
  join(agentHome, "intent-lexicon.yaml");

/** Normalize one phrase; a phrase with no word left in it is a config error naming file and group. */
function compilePhrase(raw: string, file: string, group: string): string[] {
  const tokens = tokenizePhrase(raw).filter((t) => t !== "|");
  if (tokens.length === 0)
    throw new Error(`Invalid intent lexicon ${file}: empty phrase "${raw}" in ${group}`);
  return tokens;
}

/** Read, parse (YAML + zod) and compile one lexicon file. Any problem throws an Error that names the file. */
function readGroups(file: string): CompiledGroup[] {
  let parsed: ReturnType<typeof lexiconFileSchema.safeParse>;
  try {
    parsed = lexiconFileSchema.safeParse(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {});
  } catch (err) {
    throw new Error(`Invalid intent lexicon ${file}: ${(err as Error).message}`);
  }
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid intent lexicon ${file}: ${why}`);
  }
  return Object.entries(parsed.data.groups).map(([id, g]) => ({
    id,
    effect: g.effect,
    phrases: g.phrases.map((p) => compilePhrase(p, file, id)),
    weak: (g.weak ?? []).map((p) => compilePhrase(p, file, id)),
  }));
}

/**
 * Default lexicon, with the override file (if present) merged per GROUP: an override group REPLACES the default
 * group of the same key (no deep merge), unknown keys are added. Invalid file = throws (startup refuses).
 */
export function loadLexicon(
  agentHome?: string,
  defaultFile = DEFAULT_LEXICON_FILE,
): CompiledLexicon {
  const byId = new Map(readGroups(defaultFile).map((g) => [g.id, g]));
  const override = agentHome ? lexiconOverrideFile(agentHome) : undefined;
  if (override && existsSync(override)) {
    for (const g of readGroups(override)) byId.set(g.id, g);
  }
  return { groups: [...byId.values()] };
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DesignContext } from "../design-context";

/** The parts of a bot file a review needs: what it lists and how long its instructions are. */
export interface BotFileView {
  tools: string[];
  skills: string[];
  subagents: string[];
  instructionChars: number;
}

/** Read `bots/<id>.md` (owner dir first, then shipped); undefined when no file. A bad header gives empty lists. */
export function readBotFile(ctx: DesignContext, id: string): BotFileView | undefined {
  const file = ctx.botDirs.map((d) => join(d, `${id}.md`)).find((f) => existsSync(f));
  if (!file) return undefined;
  const text = readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  let head: Record<string, unknown> = {};
  try {
    head = (Bun.YAML.parse(m?.[1] ?? "") as Record<string, unknown> | null) ?? {};
  } catch {
    // An unreadable header: the review still shows the run data.
  }
  const names = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const subagents = Array.isArray(head.subagents)
    ? head.subagents
        .map((s) => (s as { name?: unknown })?.name)
        .filter((n): n is string => typeof n === "string")
    : [];
  return {
    tools: names(head.tools),
    skills: names(head.skills),
    subagents,
    instructionChars: (m?.[2] ?? text).trim().length,
  };
}

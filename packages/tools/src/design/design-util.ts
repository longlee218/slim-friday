import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { DesignContext } from "./design-context";

/** How an env reference looks in a config value (spelled in two parts so lint does not read it as a template). */
export const ENV_REF_EXAMPLE = "$" + "{NAME}";

/** YAML in block style, one key per line (the default stringify writes one flow-style line). */
export const toYaml = (value: unknown): string => `${Bun.YAML.stringify(value, null, 2)}\n`;

/**
 * A refusal: the message goes back to the model as the tool result. `field` names the input field it is about (the
 * settings admin shows it on the form); `cause` is the parser error it wraps.
 */
export class Refused extends Error {
  constructor(
    message: string,
    readonly field?: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

/** Bot, group and skill ids: lowercase, start with a letter, at most 32 chars (skills also allow `.` and `_`). */
export const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A required text field, trimmed; refuses when it is missing or blank. */
export function need(value: string | undefined, field: string): string {
  const v = value?.trim();
  if (!v) throw new Refused(`${field} is required.`, field);
  return v;
}

/** A plain id (bot, group, MCP server); refuses anything else. */
export function plainId(value: string | undefined, field = "id"): string {
  const v = need(value, field);
  if (!ID_RE.test(v))
    throw new Refused(
      `${field} must be lowercase letters, digits and "-", starting with a letter (max 32).`,
      field,
    );
  return v;
}

/** Write a file in one step: a temp file next to it, then a rename. Creates the dir. */
export function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Front matter `name` and `description` of a SKILL.md text (undefined when absent). */
export function skillFront(text: string): { name?: string; description?: string } {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const get = (k: string) =>
    new RegExp(`^${k}:\\s*(.+)$`, "m")
      .exec(head)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
  return { name: get("name"), description: get("description") };
}

/** Skills found in `dirs` (first dir wins on a repeated name): name, description and the dir that holds it. */
export function listSkills(dirs: string[]): { name: string; description: string; dir: string }[] {
  const seen = new Map<string, { name: string; description: string; dir: string }>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name, "SKILL.md");
      if (!e.isDirectory() || seen.has(e.name) || !existsSync(file)) continue;
      seen.set(e.name, {
        name: e.name,
        description: skillFront(readFileSync(file, "utf8")).description ?? "",
        dir: join(dir, e.name),
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Put a dir in place from `files` (rel path → content), replacing any dir already there. Built aside, then renamed. */
export function replaceDir(target: string, files: Map<string, Buffer | string>): void {
  const tmp = `${target}.${process.pid}.tmp`;
  rmSync(tmp, { recursive: true, force: true });
  for (const [rel, content] of files) {
    const file = join(tmp, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(tmp, target);
}

/** The `subagents` header of an existing bot file (kept when the file is replaced); none when absent or unreadable. */
export function existingSubagents(file: string): unknown[] {
  try {
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    const parsed = Bun.YAML.parse(head) as { subagents?: unknown[] } | null;
    return Array.isArray(parsed?.subagents) ? parsed.subagents : [];
  } catch {
    return [];
  }
}

/** `avatar` in the front matter of an existing bot file; undefined when absent or unreadable. */
export function existingAvatar(file: string): string | undefined {
  try {
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    const parsed = Bun.YAML.parse(head) as { avatar?: unknown } | null;
    return typeof parsed?.avatar === "string" ? parsed.avatar : undefined;
  } catch {
    return undefined;
  }
}

/** The `description` an existing bot file has in its header, so an overwrite that leaves it out keeps it. */
export function existingDescription(file: string): string | undefined {
  try {
    const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
    const parsed = Bun.YAML.parse(head) as { description?: unknown } | null;
    return typeof parsed?.description === "string" ? parsed.description : undefined;
  } catch {
    return undefined;
  }
}

/** A workspace (of a bot or a group) must be an absolute, existing dir outside the agent home. */
export function checkWorkspace(ctx: DesignContext, ws: string): void {
  if (!isAbsolute(ws)) throw new Refused(`workspace must be an absolute path: ${ws}`);
  try {
    if (!statSync(ws).isDirectory()) throw new Error();
  } catch {
    throw new Refused(`workspace is not an existing dir: ${ws}`);
  }
  const r = relative(ctx.agentHome, ws);
  if (r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r)))
    throw new Refused(`workspace is inside the agent home: ${ws}`);
}

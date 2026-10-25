import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What `UpdateProfile` needs from the app: the owner's config dir and the app's own bot parser. */
export interface ProfileFiles {
  /** `<agent home>/config`: the bot's own file `bots/<id>.md` lies in it. */
  configDir: string;
  /** The text of `bots/<id>.md` (the owner's dir first, then the shipped one); undefined when no such bot. */
  readBotFile(id: string): string | undefined;
  /** The app's bot parser: throws a readable error when the file text is not valid. */
  checkBot(id: string, text: string): void;
}

/** The profile fields a bot may change. */
export interface ProfilePatch {
  title?: string;
  description?: string;
}

/** A refusal whose message goes back to the model. */
export class ProfileRefused extends Error {}

/** Header line of `key: value` as a YAML string (JSON strings are valid YAML), one line only. */
const yamlLine = (key: string, value: string): string => `${key}: ${JSON.stringify(value)}`;

/**
 * Replace (or add, after `title`) the `title` and `description` lines of a bot file's header, keeping every other
 * line and the body byte for byte. Throws when the file has no header.
 */
export function patchHeader(text: string, fields: Record<string, string>): string {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/.exec(text);
  if (!m) throw new ProfileRefused("the bot file has no header.");
  const lines = (m[2] ?? "").split(/\r?\n/);
  for (const [key, value] of Object.entries(fields)) {
    const own = new RegExp(`^${key}:`);
    // A key's value may continue on indented lines: drop those with it.
    const at = lines.findIndex((l) => own.test(l));
    if (at >= 0) {
      let end = at + 1;
      while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end++;
      lines.splice(at, end - at, yamlLine(key, value));
    } else {
      const after = lines.findIndex((l) => /^title:/.test(l));
      lines.splice(after >= 0 ? after + 1 : lines.length, 0, yamlLine(key, value));
    }
  }
  return `${m[1]}${lines.join("\n")}${m[3]}${m[4]}`;
}

/**
 * Write the new title and/or description into bot `botId`'s own file in the owner's config dir. The id comes from the
 * session, never from the model. A shipped bot (no file of its own) and an unparsable result are refused; nothing
 * is written then.
 */
export function updateProfile(files: ProfileFiles, botId: string, patch: ProfilePatch): void {
  const fields: Record<string, string> = {};
  for (const key of ["title", "description"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!v.trim()) throw new ProfileRefused(`${key} must not be empty.`);
    if (/[\r\n]/.test(v.trim())) throw new ProfileRefused(`${key} must be one line.`);
    fields[key] = v.trim();
  }
  if (Object.keys(fields).length === 0)
    throw new ProfileRefused("give a title, a description or both.");
  const file = join(files.configDir, "bots", `${botId}.md`);
  if (!existsSync(file)) throw new ProfileRefused("your bot file is read only: no profile change.");
  const text = files.readBotFile(botId);
  if (text === undefined) throw new ProfileRefused("your bot file was not found.");
  const next = patchHeader(text, fields);
  try {
    files.checkBot(botId, next);
  } catch (err) {
    throw new ProfileRefused(`not valid: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
}

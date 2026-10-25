import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { AdminError } from "@friday/core";

/** The nearest dir at or above `dir` that exists, and what lies below it (a dir to be created has a missing tail). */
function existingAncestor(dir: string): { base: string; rest: string } {
  let d = dir;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return { base: d, rest: relative(d, dir) };
}

/**
 * The file to write, with the real path of its parent: refused when that lies outside `configDir`, also through a
 * symlinked `bots/` or `groups/`. Checked before every write; the id was already checked by `plainId`.
 */
export function insideConfig(configDir: string, file: string): string {
  const root = realpathSync(configDir);
  const { base, rest } = existingAncestor(dirname(file));
  const parent = realpathSync(base);
  const r = relative(root, parent);
  if (r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r))
    throw new AdminError("BAD_REQUEST", "the file is outside the config dir");
  return join(parent, rest, basename(file));
}

/** Like `insideConfig`, and the file itself must not be a symlink (a link in the config dir is never followed). */
export function insideConfigFile(configDir: string, file: string): string {
  const real = insideConfig(configDir, file);
  try {
    // lstat, not exists: a dangling link has no target but must still be refused.
    if (lstatSync(real).isSymbolicLink())
      throw new AdminError("BAD_REQUEST", "the file is a symlink");
  } catch (err) {
    if (err instanceof AdminError) throw err; // anything else: the file does not exist yet
  }
  return real;
}

/** `<config>/bots/<id>.md` (the id is already checked). */
export const botFileOf = (configDir: string, id: string): string =>
  join(configDir, "bots", `${id}.md`);

/** `<config>/groups/<id>.yaml` (the id is already checked). */
export const groupFileOf = (configDir: string, id: string): string =>
  join(configDir, "groups", `${id}.yaml`);

/** The YAML header and the body of a bot file text; the body is kept exactly as written. */
export function splitBotFile(text: string): { header: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const header = Bun.YAML.parse(m?.[1] ?? "") as Record<string, unknown> | null;
  return { header: header ?? {}, body: m?.[2] ?? "" };
}

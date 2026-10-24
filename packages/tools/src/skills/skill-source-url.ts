import { Refused } from "../design/design-util";

/** A path inside the cloned repo: relative, plain characters, never an option. */
const SKILL_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * Check a skill source typed in the browser: an `https:` URL without credentials, and an optional relative path
 * inside the repo. Anything git could read as an option (`-x`), a helper transport (`ext::`) or a second argument
 * (whitespace) is refused. Refusals carry the field (`source` or `path`) for the settings form.
 */
export function parseSkillSource(source: string, path?: string): { url: string; path?: string } {
  if (source.startsWith("-") || source.includes("::") || /\s/.test(source))
    throw new Refused("source must be a plain https URL.", "source");
  let u: URL;
  try {
    u = new URL(source);
  } catch (e) {
    throw new Refused("source must be a valid https URL.", "source", e);
  }
  // Git gets exactly what the parser understood: a spelling WHATWG rewrites (`https:evil.com`, backslashes,
  // empty userinfo, upper-case scheme) is refused rather than normalised.
  if (source !== u.href)
    throw new Refused("source must be written as a normalised https URL.", "source");
  if (u.protocol !== "https:") throw new Refused("source must use https.", "source");
  if (u.username || u.password)
    throw new Refused("source must not contain a username or password.", "source");
  if (path === undefined) return { url: u.href };
  const bad =
    !SKILL_PATH_RE.test(path) ||
    path.startsWith("/") ||
    path.startsWith("-") ||
    path.split("/").includes("..");
  if (bad)
    throw new Refused(
      "path must be relative, without .. (letters, digits, . _ / -; max 200).",
      "path",
    );
  return { url: u.href, path };
}

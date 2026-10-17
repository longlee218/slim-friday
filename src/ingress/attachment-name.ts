import { foldText } from "../memory/index/fold-text";

/** The OS file name limit in bytes; a longer name is refused (the fallback name is used), never cut. */
const NAME_MAX_BYTES = 255;

/**
 * The first `# <title>` line of a text (the title the model wrote), or undefined when there is none. Lines inside a
 * ``` code fence are skipped: a shell comment (`# install deps`) is not a title.
 */
export function headingTitle(text: string): string | undefined {
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    else if (!inFence) {
      const m = /^# +(\S.*)$/.exec(line);
      if (m) return m[1]?.trim();
    }
  }
  return undefined;
}

/**
 * A title made filesystem-safe: accents folded, lowercase, every run of non `a-z0-9` chars becomes one `-`. ASCII only,
 * so the name survives Discord's `attachment://` reference unchanged (a title with no Latin letter or digit has no slug).
 */
function slugOf(title: string): string {
  return foldText(title)
    .normalize("NFD")
    .replace(/\p{M}/gu, "") // combining marks left by NFD: "ế" -> "e"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * File name of an attachment: the model's title made filesystem-safe (no length cap of ours), plus `.ext`.
 * `prefix` (e.g. a date) goes before the slug. No title, an empty slug or a name over the OS limit gives
 * `<fallback>.<ext>`: the code never invents a title and never cuts one.
 */
export function attachmentName(
  title: string | undefined,
  ext: string,
  opts: { fallback?: string; prefix?: string } = {},
): string {
  const slug = title ? slugOf(title) : "";
  const name = `${opts.prefix ?? ""}${slug}.${ext}`;
  if (!slug || Buffer.byteLength(name) > NAME_MAX_BYTES)
    return `${opts.fallback ?? "reply"}.${ext}`;
  return name;
}

import { safePreview } from "./redact";

/** Input keys that carry file content (Write, Edit, MultiEdit, NotebookEdit); never logged. */
const BODY_KEYS = new Set(["content", "new_string", "old_string", "new_source"]);

/** Depth limit of the body scan (MultiEdit nests `edits: [{old_string, new_string}]`). */
const MAX_DEPTH = 3;

/** Copy of `v` with every body string replaced by `<N chars>`. */
function maskBodies(v: unknown, depth = 0): unknown {
  if (!v || typeof v !== "object" || depth >= MAX_DEPTH) return v;
  if (Array.isArray(v)) return v.map((x) => maskBodies(x, depth + 1));
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      BODY_KEYS.has(k) && typeof x === "string" ? `<${x.length} chars>` : maskBodies(x, depth + 1),
    ]),
  );
}

/** Redacted, capped preview of a tool input for the app log, with file content replaced by sizes. */
export function inputPreview(input: unknown, maxBytes = 300): string {
  return safePreview(maskBodies(input), maxBytes);
}

/** Bodies shorter than this are not searched for in error text (too many false hits). */
const MIN_BODY = 4;

/**
 * Error text of a failed edit without the file text it echoes: only the first line is kept
 * (the SDK appends `String: <old_string>`), and any body of the input found in it is cut out.
 */
export function scrubEditError(err: string, input: unknown): string {
  let out = err.split("\n")[0] ?? "";
  const walk = (v: unknown, depth = 0): void => {
    if (!v || typeof v !== "object" || depth >= MAX_DEPTH) return;
    for (const [k, x] of Object.entries(v)) {
      if (BODY_KEYS.has(k) && typeof x === "string" && x.length >= MIN_BODY)
        out = out.replaceAll(x, `<${x.length} chars>`);
      else walk(x, depth + 1);
    }
  };
  walk(input);
  return out;
}

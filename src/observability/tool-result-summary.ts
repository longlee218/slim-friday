import { errText } from "./redact";

/** Size facts about a tool result. Never carries the result text itself. */
export interface ResultSummary {
  /** Size of the result in chars (string length, text length, or JSON length). */
  chars?: number;
  /** `chars` is a text-volume estimate (unknown result shape), not an exact size. */
  approx?: true;
  /** Line count when the tool reports one (Read, Grep). */
  lines?: number;
  /** File count when the tool reports one (Grep, Glob). */
  files?: number;
  /** The tool said it cut its result. */
  truncated?: true;
  /** Redacted error text (200 chars max), only for failed calls. */
  err?: string;
}

/** Max chars of an error text on a log line. */
const ERR_MAX = 200;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

/** Limits of the generic text-size walk (no result is ever serialized to count it). */
const WALK_DEPTH = 3;
const WALK_NODES = 1000;

/** Sum of string lengths in `v` (arrays and objects, shallow-capped); the text volume, not JSON size. */
function textSize(v: unknown, depth = 0, budget = { n: WALK_NODES }): number {
  if (typeof v === "string") return v.length;
  if (!isObj(v) || depth >= WALK_DEPTH || budget.n-- <= 0) return 0;
  let total = 0;
  for (const x of Array.isArray(v) ? v : Object.values(v)) total += textSize(x, depth + 1, budget);
  return total;
}

/** Result size in chars and whether it is exact. Never stringifies the result. */
function sizeOf(output: unknown): { chars: number; approx?: true } | undefined {
  if (typeof output === "string") return { chars: output.length };
  if (!isObj(output)) return undefined;
  const file = isObj(output.file) ? output.file : undefined;
  if (typeof file?.content === "string") return { chars: file.content.length }; // Read
  if (typeof output.stdout === "string" || typeof output.stderr === "string")
    return { chars: String(output.stdout ?? "").length + String(output.stderr ?? "").length };
  if (Array.isArray(output.content) && output.content.every((p) => isObj(p)))
    return { chars: textSize(output.content.map((p: Record<string, unknown>) => p.text)) }; // MCP
  const chars = textSize(output);
  return chars > 0 ? { chars, approx: true } : undefined;
}

/**
 * Sizes and counts of a tool result, for the `tool.done` line. Pure; reads only numbers/lengths
 * (Read `file.numLines`, Grep/Glob `numLines`/`numFiles`/`truncated`), never copies content.
 */
export function summarizeResult(output: unknown, isError: boolean): ResultSummary {
  const out: ResultSummary = {};
  Object.assign(out, sizeOf(output));
  if (isObj(output)) {
    const file = isObj(output.file) ? output.file : undefined;
    const lines = num(file?.numLines) ?? num(output.numLines);
    if (lines !== undefined) out.lines = lines;
    const files = num(output.numFiles);
    if (files !== undefined) out.files = files;
    if (output.truncated === true) out.truncated = true;
  }
  if (isError) out.err = errText(output, ERR_MAX);
  return out;
}

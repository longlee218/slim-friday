import type { RunStep } from "../domain/run";

/** What replaces a secret. */
export const REDACTED = "[redacted]";

/** What a text becomes when redaction itself fails (the original is never kept). */
export const REDACTION_FAILED = "[redaction failed]";

/** Env values shorter than this are never redacted (too short to be a secret; they would mangle normal text). */
const MIN_VALUE_LENGTH = 8;

/** Token shapes that are secrets wherever they appear. */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
];

/**
 * Replace secrets in `text` with `[redacted]`: every configured value of 8+ chars (longest first, so a value
 * that contains another is cut whole) and the known token shapes. Never throws: on an internal error it
 * returns `[redaction failed]`.
 */
export function redactSecrets(text: string, values: readonly string[]): string {
  try {
    let out = text;
    const secrets = values
      .filter((v) => v.length >= MIN_VALUE_LENGTH)
      .sort((a, b) => b.length - a.length);
    for (const v of secrets) out = out.split(v).join(REDACTED);
    for (const p of PATTERNS) out = out.replace(p, REDACTED);
    return out;
  } catch {
    return REDACTION_FAILED;
  }
}

/** `redactSecrets` over every string inside a JSON-like value (objects and arrays are copied, not changed). */
export function redactValue<T>(value: T, values: readonly string[]): T {
  if (typeof value === "string") return redactSecrets(value, values) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, values)) as T;
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactValue(v, values)]),
    ) as T;
  return value;
}

/** The configured secret values of a source (the app's lazy list); none when unset or when it throws. */
export function secretsFrom(source: (() => string[]) | undefined): string[] {
  try {
    return source?.() ?? [];
  } catch {
    return [];
  }
}

/** A run step with its label and target redacted (a Bash command can carry a secret). */
export function redactStep(step: RunStep, values: readonly string[]): RunStep {
  return {
    ...step,
    label: redactSecrets(step.label, values),
    ...(step.target !== undefined && { target: redactSecrets(step.target, values) }),
  };
}

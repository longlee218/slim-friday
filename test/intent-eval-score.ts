import type { IntentDecision } from "../src/intent/decide-intent";

/** Class the decision has in production: the resolver defaults a class-less staged task to `standard`. */
export function effectiveClass(d: IntentDecision): string | undefined {
  if (d.kind !== "role") return undefined;
  return d.cls ?? (d.role === "dev" ? "standard" : undefined);
}

/** Class pass flags against `expected`: raw (the decision's own class) and effective (missing = standard). */
export function scoreClass(
  d: IntentDecision,
  expected: string,
): { raw: boolean; effective: boolean } {
  return {
    raw: d.kind === "role" && d.cls === expected,
    effective: effectiveClass(d) === expected,
  };
}

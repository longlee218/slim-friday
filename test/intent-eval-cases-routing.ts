import { BAND_CASES } from "./intent-eval-cases-routing-bands";
import { CONTINUATION_CASES } from "./intent-eval-cases-routing-continuation";
import { FALLBACK_CASES } from "./intent-eval-cases-routing-fallback";
import type { RoutingCase } from "./intent-eval-cases-routing-types";

export * from "./intent-eval-cases-routing-types";

/** Deterministic routing golden cases, by theme (runner: routing-policy-golden.test.ts). */
export const ROUTING_CASES: RoutingCase[] = [
  ...CONTINUATION_CASES,
  ...BAND_CASES,
  ...FALLBACK_CASES,
];

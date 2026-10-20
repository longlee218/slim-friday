import type { Envelope } from "./plan-types";

/** True when every member of `next` is already in `old`. */
const within = (next: readonly string[], old: readonly string[]): boolean =>
  next.every((x) => old.includes(x));

/**
 * True when the revised envelope asks for more than the approved one: a new role, location or risk class, a higher
 * bound or a higher (code-computed) budget, or a delivery effect not granted before. Only then does the owner approve again (5.12). Pure.
 */
export function envelopeGrew(old: Envelope, next: Envelope): boolean {
  return (
    !within(next.roles, old.roles) ||
    !within(next.locations, old.locations) ||
    !within(next.riskClasses, old.riskClasses) ||
    next.bounds.maxItems > old.bounds.maxItems ||
    next.bounds.maxGb > old.bounds.maxGb ||
    next.budgetUsd > old.budgetUsd ||
    !within(next.effects, old.effects)
  );
}

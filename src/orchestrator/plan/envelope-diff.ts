import type { Envelope } from "./plan-types";

/** True when every member of `next` is already in `old`. */
const within = (next: readonly string[], old: readonly string[]): boolean =>
  next.every((x) => old.includes(x));

/**
 * True when the revised envelope asks for more than the approved one: a new role, location or risk class, a higher
 * bound or budget, or another delivery mode. Only then does the owner approve again (5.12). Pure.
 */
export function envelopeGrew(old: Envelope, next: Envelope): boolean {
  return (
    !within(next.roles, old.roles) ||
    !within(next.locations, old.locations) ||
    !within(next.riskClasses, old.riskClasses) ||
    next.bounds.maxItems > old.bounds.maxItems ||
    next.bounds.maxGb > old.bounds.maxGb ||
    next.budgetUsd > old.budgetUsd ||
    next.deliveryMode !== old.deliveryMode
  );
}

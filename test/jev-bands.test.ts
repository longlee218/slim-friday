import { expect, test } from "bun:test";
import type { JevAnswers } from "../src/intent/jev/jev-answer-schema";
import { decideBands } from "../src/intent/jev/jev-bands";
import type { RoleDefinition } from "../src/roles/role-types";

// Synthetic roles: one per risk class (the bands read `sideEffects` only, never names).
const role = (name: string, sideEffects: RoleDefinition["sideEffects"]) =>
  [name, { name, sideEffects, whenToUse: name } as RoleDefinition] as const;
const roles = new Map([role("reader", "none"), role("coder", "repo"), role("sender", "external")]);

/** Answers with `role` probabilities and optional Noul values. */
const ans = (
  probs: Record<string, number>,
  o: { multi?: number; cont?: number; fits?: number } = {},
): JevAnswers => {
  const [choice] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
  return {
    role: { choice, probabilities: probs, confidence: 0.9 },
    multi_intent: { noul: o.multi ?? 0 },
    ...(o.cont !== undefined && { continues_task: { noul: o.cont } }),
    ...(o.fits !== undefined && { fits_last_role: { noul: o.fits } }),
  };
};
const band = (a: JevAnswers) => decideBands(a, roles);

test("pick: act threshold scales with side effects (none 0.6 / repo 0.85 / external 0.9)", () => {
  // Same shape of answer (top vs a far runner-up), only the risk class differs.
  expect(band(ans({ reader: 0.65, coder: 0.1, unclear: 0.25 })).kind).toBe("pick");
  expect(band(ans({ coder: 0.65, reader: 0.1, unclear: 0.25 }))).toMatchObject({
    kind: "undecided",
    reason: "low_confidence",
  });
  expect(band(ans({ coder: 0.88, reader: 0.1, unclear: 0.02 })).kind).toBe("pick");
  expect(band(ans({ sender: 0.88, reader: 0.1, unclear: 0.02 })).kind).toBe("undecided");
  expect(band(ans({ sender: 0.93, reader: 0.05, unclear: 0.02 })).kind).toBe("pick");
});

test("pick: ratio edge (top / second >= 2) and alternatives", () => {
  const tie = band(ans({ reader: 0.62, coder: 0.38 }));
  expect(tie).toMatchObject({ kind: "undecided", reason: "low_confidence" });
  const ok = band(ans({ reader: 0.7, coder: 0.35 })); // ratio exactly 2
  expect(ok).toMatchObject({ kind: "pick", role: "reader", alternatives: ["coder"] });
  expect(ok.scores).toMatchObject({ top: 0.7, ratio: 2, confidence: 0.9, band: "pick" });
});

test("unclear and an unknown role are undecided with a reason", () => {
  expect(band(ans({ unclear: 0.9, reader: 0.1 }))).toMatchObject({ reason: "unclear" });
  expect(band(ans({ ghost: 0.9, reader: 0.1 }))).toMatchObject({ reason: "unknown_role" });
});

test("multi intent at >= 0.8 returns the top two roles (unclear excluded)", () => {
  const p = band(ans({ reader: 0.5, coder: 0.3, unclear: 0.2 }, { multi: 0.8 }));
  expect(p).toMatchObject({ kind: "multi", roles: ["reader", "coder"] });
  expect(band(ans({ reader: 0.9, coder: 0.05, unclear: 0.05 }, { multi: 0.79 })).kind).toBe("pick");
});

test("open task: continue >= 0.8; <= 0.2 falls to the pick; between is undecided", () => {
  const strong = { reader: 0.9, coder: 0.05, unclear: 0.05 };
  expect(band(ans(strong, { cont: 0.8 })).kind).toBe("continue");
  expect(band(ans(strong, { cont: 0.2 })).kind).toBe("pick");
  expect(band(ans(strong, { cont: 0.5 }))).toMatchObject({
    kind: "undecided",
    reason: "low_confidence",
  });
  // Multi-intent wins over continue.
  expect(band(ans(strong, { cont: 0.95, multi: 0.9 })).kind).toBe("multi");
});

test("numbers pass through: fitsLastP, continueP, ranking without unclear", () => {
  const p = band(ans({ reader: 0.5, coder: 0.3, unclear: 0.2 }, { fits: 0.75, cont: 0.1 }));
  expect(p.scores).toMatchObject({ fitsLastP: 0.75, continueP: 0.1, multiP: 0 });
  expect(p.scores?.ranking).toEqual({ reader: 0.5, coder: 0.3 });
});

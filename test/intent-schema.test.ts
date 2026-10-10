import { expect, test } from "bun:test";
import { parseIntentText, validateIntent } from "../src/intent/intent-schema";
import { IntentEngineError, type IntentResult } from "../src/intent/intent-types";

const ok = {
  role: "dev",
  scope: "new",
  class: "standard",
  confidence: "high",
  reason: "asks a change",
};
const json = (o: unknown) => JSON.stringify(o);

test("parse: plain JSON, fenced JSON and JSON with chatter around it", () => {
  expect(parseIntentText(json(ok))).toEqual(ok as IntentResult);
  expect(parseIntentText(`\`\`\`json\n${json(ok)}\n\`\`\``)).toEqual(ok as IntentResult);
  expect(parseIntentText(`Sure! ${json(ok)} Hope that helps.`)).toEqual(ok as IntentResult);
});

test("parse: null / missing class is dropped, long reason is cut to 200", () => {
  const r = parseIntentText(json({ ...ok, class: null, reason: "x".repeat(500) }));
  expect(r.class).toBeUndefined();
  expect(r.reason).toHaveLength(200);
  expect(parseIntentText(json({ role: "assistant", scope: "new", confidence: "low" })).reason).toBe(
    "",
  );
});

test("parse: every kind of bad output is a schema error", () => {
  const bad = [
    "",
    "no json here",
    "{not json}",
    json({ ...ok, role: "" }),
    json({ ...ok, scope: "later" }),
    json({ ...ok, confidence: "sure" }),
    json({ ...ok, class: "huge" }),
    json({ role: "dev" }),
    json(["dev"]),
  ];
  for (const text of bad) {
    try {
      parseIntentText(text);
      throw new Error(`accepted: ${text}`);
    } catch (e) {
      expect(e).toBeInstanceOf(IntentEngineError);
      expect((e as IntentEngineError).reason).toBe("schema");
    }
  }
});

const raw = (over: Partial<IntentResult> = {}): IntentResult => ({
  ...(ok as IntentResult),
  ...over,
});

test("validate: unknown role -> not ok (the owner is asked)", () => {
  expect(validateIntent(raw({ role: "admin" }), { hasTask: false })).toEqual({
    ok: false,
    reason: "unknown_role",
  });
  // prototype keys are not roles
  expect(validateIntent(raw({ role: "constructor" }), { hasTask: false }).ok).toBe(false);
});

test("validate: scope only counts when the thread has a task", () => {
  const r = (hasTask: boolean) =>
    validateIntent(raw({ scope: "active" }), { hasTask }) as { ok: true; result: IntentResult };
  expect(r(false).result.scope).toBe("new");
  expect(r(true).result.scope).toBe("active");
});

test("validate: class only for a role with class tiers; owner prefix > model > L2 hint", () => {
  const cls = (r: IntentResult, v: Parameters<typeof validateIntent>[1]) => {
    const out = validateIntent(r, v);
    return out.ok ? out.result.class : "not-ok";
  };
  expect(cls(raw({ class: "mechanical" }), { hasTask: false })).toBe("mechanical");
  expect(cls(raw({ class: "mechanical" }), { hasTask: false, ownerClass: "design" })).toBe(
    "design",
  );
  expect(cls(raw({ class: undefined }), { hasTask: false, classHint: "design" })).toBe("design");
  // assistant has no class tiers: dropped whatever the source
  expect(
    cls(raw({ role: "assistant", class: "design" }), { hasTask: false, ownerClass: "design" }),
  ).toBeUndefined();
});

test("validate: `mechanical` is kept only with high confidence, else standard; never upgraded", () => {
  const cls = (c: IntentResult["class"], confidence: IntentResult["confidence"], v = {}) => {
    const out = validateIntent(raw({ class: c, confidence }), { hasTask: false, ...v });
    return out.ok ? out.result.class : "not-ok";
  };
  expect(cls("mechanical", "high")).toBe("mechanical");
  expect(cls("mechanical", "medium")).toBe("standard");
  expect(cls("mechanical", "low")).toBe("standard");
  expect(cls("standard", "medium")).toBe("standard");
  expect(cls("design", "medium")).toBe("design");
  // owner prefix is not downgraded
  expect(cls("mechanical", "medium", { ownerClass: "mechanical" })).toBe("mechanical");
});

test("parse: `ask` is redacted and cut to 200, `pendingAnswer` only yes / no; null / empty are dropped", () => {
  const r = parseIntentText(
    json({
      ...ok,
      confidence: "low",
      ask: `Ý bạn là gì? token sk-ant-abcdefghijklmnop123456 ${"x".repeat(400)}`,
      pendingAnswer: "yes",
    }),
  );
  expect(r.ask?.length).toBeLessThanOrEqual(200);
  expect(r.ask).not.toContain("sk-ant-abcdefghijklmnop123456");
  expect(r.pendingAnswer).toBe("yes");
  const n = parseIntentText(json({ ...ok, ask: null, pendingAnswer: null }));
  expect(n).not.toHaveProperty("ask");
  expect(n).not.toHaveProperty("pendingAnswer");
  expect(parseIntentText(json({ ...ok, ask: "  " }))).not.toHaveProperty("ask");
  expect(() => parseIntentText(json({ ...ok, pendingAnswer: "maybe" }))).toThrow(IntentEngineError);
});

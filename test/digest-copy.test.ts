import { expect, test } from "bun:test";
import { type DigestFacts, renderDigest } from "../src/ingress/digest-copy";

const facts: DigestFacts = {
  objective: "Ship it",
  items: [
    {
      key: "a",
      role: "developer",
      status: "running",
      held: false,
      percent: 50,
      note: "half",
      ageSeconds: 120,
    },
    { key: "b", role: "tester", status: "blocked", held: true, ageSeconds: 7200 },
  ],
  done: 1,
  total: 3,
  spentUsd: 2.5,
  budgetUsd: 15,
};

test("en digest: objective, counts, item lines, held flag, spend", () => {
  const t = renderDigest(facts, "en");
  expect(t).toBe(
    [
      "Check-in: Ship it",
      "1/3 items done.",
      "- a (developer): running 50%, half, 2m",
      "- b (tester): blocked, 2h - waiting for decision",
      "Spend: $2.50 / $15",
    ].join("\n"),
  );
});

test("vi digest", () => {
  const t = renderDigest(facts, "vi");
  expect(t).toContain("Cập nhật: Ship it");
  expect(t).toContain("Xong 1/3 việc.");
  expect(t).toContain("đang chờ quyết định");
  expect(t).toContain("Chi phí: $2.50 / $15");
});

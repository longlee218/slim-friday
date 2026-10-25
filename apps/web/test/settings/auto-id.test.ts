import { BotIdSchema } from "@friday/contracts";
import { expect, test } from "vitest";
import { autoId } from "../../src/components/settings/auto-id";

test("an id from a display name: no accents, đ is d, dashes, starts with a letter", () => {
  expect(autoId("Nhà phân tích", [], "bot")).toBe("nha-phan-tich");
  expect(autoId("Đội  Dữ liệu!", [], "group")).toBe("doi-du-lieu");
  expect(autoId("2nd Reviewer", [], "bot")).toBe("nd-reviewer");
  expect(autoId("🦔", [], "bot")).toBe("bot");
});

test("a taken id gets -2, -3; the result always passes the id schema (32 chars)", () => {
  expect(autoId("Analyst", ["analyst"], "bot")).toBe("analyst-2");
  expect(autoId("Analyst", ["analyst", "analyst-2"], "bot")).toBe("analyst-3");
  const long = autoId("x".repeat(40), ["x".repeat(32)], "bot");
  expect(long).toBe(`${"x".repeat(30)}-2`);
  for (const id of [long, autoId("", [], "bot"), autoId("a-", [], "bot")])
    expect(BotIdSchema.safeParse(id).success).toBe(true);
});

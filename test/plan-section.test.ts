import { expect, test } from "bun:test";
import { planHeadings, planSection } from "../src/orchestrator/plan/plan-section";

/* Section helpers: a heading of the plan text, and the text under it. */

const MD = [
  "# Plan",
  "intro",
  "## Step 1: Login",
  "do login",
  "### Detail",
  "deep",
  "## Step 2",
  "do two",
  "```sh",
  "# not a heading",
  "```",
  "# Other",
  "closing",
].join("\n");

test("section runs to the next heading of the same or a higher level", () => {
  expect(planSection(MD, "Step 1: Login")).toBe("do login\n### Detail\ndeep");
  expect(planSection(MD, "Step 2")).toBe("do two\n```sh\n# not a heading\n```");
});

test("match ignores case and spaces; a top heading runs to the next top heading", () => {
  expect(planSection(MD, "  step 1: LOGIN ")).toContain("do login");
  expect(planSection(MD, "plan")).toContain("intro");
  expect(planSection(MD, "plan")).not.toContain("closing");
});

test("missing heading is undefined; headings inside code fences are ignored", () => {
  expect(planSection(MD, "nope")).toBeUndefined();
  expect(planSection(MD, "not a heading")).toBeUndefined();
  expect(planHeadings(MD).map((h) => h.text)).toEqual([
    "Plan",
    "Step 1: Login",
    "Detail",
    "Step 2",
    "Other",
  ]);
});

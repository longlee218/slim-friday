import { expect, test } from "bun:test";
import { demoteHeadings } from "../src/text/demote-headings";

test("demoteHeadings pushes headings down, caps at six, and leaves code fences and non-headings alone", () => {
  const src = [
    "# A",
    "## B",
    "text # not a heading",
    "#hashtag",
    "```",
    "# in code",
    "```",
    "###### F",
  ].join("\n");
  expect(demoteHeadings(src, 2).split("\n")).toEqual([
    "### A",
    "#### B",
    "text # not a heading",
    "#hashtag",
    "```",
    "# in code",
    "```",
    "###### F",
  ]);
});

test("a persona block keeps its own headings below its `## <FILE>.md` heading", async () => {
  const { buildPersonaContext } = await import("../src/memory/persona");
  const { makeEnv } = await import("./helpers");
  const { writeFileSync } = await import("node:fs");
  const env = makeEnv();
  writeFileSync(`${env.home}/AGENTS.md`, "# Agents\n\n## Language\n- Reply in Vietnamese.\n");
  const { text } = buildPersonaContext(env.home, undefined, undefined, "# TEAM\n\n## Members\n- x");
  expect(text).toContain("## TEAM.md\n\n### TEAM\n\n#### Members");
  expect(text).toContain("## AGENTS.md\n\n### Agents\n\n#### Language");
  expect(text.indexOf("## TEAM.md")).toBeLessThan(text.indexOf("## AGENTS.md"));
});

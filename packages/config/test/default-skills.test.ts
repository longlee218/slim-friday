import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SKILLS_DIR } from "../src/load-config";

/** The frontmatter `name:` and `description:` lines of a SKILL.md. */
function front(text: string): { name?: string; description?: string } {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(head)?.[1]?.trim();
  return { name: get("name"), description: get("description") };
}

test("every shipped skill dir has a SKILL.md whose name matches the dir and has a description", () => {
  const dirs = readdirSync(DEFAULT_SKILLS_DIR, { withFileTypes: true }).filter((e) =>
    e.isDirectory(),
  );
  expect(dirs.map((d) => d.name).sort()).toEqual([
    "bot-design",
    "bot-tuning",
    "find-skill",
    "office-files",
    "skill-creator",
    "skill-install",
  ]);
  for (const d of dirs) {
    const file = join(DEFAULT_SKILLS_DIR, d.name, "SKILL.md");
    expect(existsSync(file)).toBe(true);
    const f = front(readFileSync(file, "utf8"));
    expect(f.name).toBe(d.name);
    expect(f.description?.length).toBeGreaterThan(20);
  }
});

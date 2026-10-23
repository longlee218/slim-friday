import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as orchestrateNames from "../src/mcp/orchestration/tools/OrchestrateTool/action-names";
import * as reportNames from "../src/mcp/orchestration/tools/ReportTool/action-names";
import * as taskBoardNames from "../src/mcp/orchestration/tools/TaskBoardTool/action-names";
import { PUBLISHER_SKILLS_DIR } from "../src/runtime/skills-plugin/publisher-skills";

/* Drift guards for the app-owned skills (`.agents/skills/<name>/references/*.md`): the refusal codes and the action
   names they list must exist in the code, so a renamed code or action fails a test instead of misleading a model. */

/** Every file under `dir` whose name ends with `ext` (hidden dirs included: readdir does not skip them). */
function files(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/** The `*_ACTION_*` constants of an action-names module: the action names of its tool. */
const actionsOf = (mod: Record<string, unknown>): string[] =>
  Object.entries(mod)
    .filter(([k, v]) => /_ACTION_/.test(k) && typeof v === "string")
    .map(([, v]) => v as string)
    .sort();

/** Skill folder -> the tool whose actions its `references/actions.md` documents. */
const ACTION_TOOLS: Record<string, string[]> = {
  "teammate-orchestration": actionsOf(orchestrateNames),
  "worker-reporting": actionsOf(reportNames),
};

const skillDirs = readdirSync(PUBLISHER_SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

test("every UPPER_CASE refusal code in a skill's references/refusals.md exists as a word in src", () => {
  const src = files("src", ".ts")
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const missing: string[] = [];
  let checked = 0;
  for (const d of skillDirs) {
    const file = join(PUBLISHER_SKILLS_DIR, d, "references", "refusals.md");
    if (!existsSync(file)) continue;
    // Table rows only: the first cell holds the backticked code(s), e.g. | `ONE_PER_RUN` | ...
    for (const row of readFileSync(file, "utf8").split("\n")) {
      const cell = /^\|\s*([^|]*)\|/.exec(row)?.[1] ?? "";
      for (const m of cell.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) {
        checked++;
        const code = m[1] as string;
        if (!new RegExp(`\\b${code}\\b`).test(src)) missing.push(`${d}: ${code}`);
      }
    }
  }
  expect(checked).toBeGreaterThan(20);
  expect(missing).toEqual([]);
});

test("every action heading in a skill's references/actions.md is a real action, and every action has one", () => {
  const seen: string[] = [];
  for (const d of skillDirs) {
    const file = join(PUBLISHER_SKILLS_DIR, d, "references", "actions.md");
    if (!existsSync(file)) continue;
    const known = ACTION_TOOLS[d];
    expect(known, `${d} has an actions.md but no tool mapped in this test`).toBeDefined();
    // Headings `## <action>` (one lowercase word); other headings ("Item fields ...") are not actions.
    const headings = [...readFileSync(file, "utf8").matchAll(/^## ([a-z][a-z_]*)\s*$/gm)]
      .map((m) => m[1] as string)
      .sort();
    expect(headings).toEqual(known as string[]);
    seen.push(d);
  }
  expect(seen).toEqual(expect.arrayContaining(["teammate-orchestration"]));
});

test("team-protocol names every TaskBoard action; worker skills never tell a worker to SaveArtifact", () => {
  const text = (name: string) =>
    files(join(PUBLISHER_SKILLS_DIR, name), ".md")
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
  const protocol = text("team-protocol");
  const missing = actionsOf(taskBoardNames).filter((a) => !protocol.includes(`\`${a}\``));
  expect(missing).toEqual([]);
  for (const d of ["team-protocol", "worker-reporting"]) {
    expect(text(d), `${d} mentions SaveArtifact`).not.toContain("SaveArtifact");
  }
});

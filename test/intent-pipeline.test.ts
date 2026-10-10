import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LEXICON_FILE, lexiconOverrideFile, loadLexicon } from "../src/intent/load-lexicon";
import { createRoleTagRouter } from "../src/intent/role-tag";
import { runIntentPipeline } from "../src/intent/run-intent-pipeline";
import { ROLES } from "../src/roles/role-registry";

const realRoles = Object.values(ROLES);
const router = createRoleTagRouter(realRoles);

describe("role tag router (L1, real registry data)", () => {
  test("registry tags pass validation", () => {
    expect(() => createRoleTagRouter(realRoles)).not.toThrow();
  });
  test("only a LEADING tag routes: case-insensitive, leading space ignored, tag stripped", () => {
    expect(router.route("[dev] add a retry")).toEqual({ role: "dev", rest: "add a retry" });
    expect(router.route("  [ASK]  why?")).toEqual({ role: "assistant", rest: "why?" });
    expect(router.route("[Dev]fix it")).toEqual({ role: "dev", rest: "fix it" });
  });
  test("no natural-language matching: words, phrases and mid-text tags never route", () => {
    for (const t of [
      "dev",
      "ask",
      "giao cho dev nhé",
      "code đi",
      "fix bug login",
      "đừng code",
      "we should ask the dev team",
      "add [dev] later",
      "[devops] check",
      "hello",
    ])
      expect(router.route(t)).toBeUndefined();
  });
  test("duplicate (case-insensitive) or malformed tags = startup error; roles without a tag are fine", () => {
    expect(() =>
      createRoleTagRouter([
        { name: "a", tag: "[x]" },
        { name: "b", tag: "[X]" },
      ]),
    ).toThrow(/used by roles a and b/);
    expect(() => createRoleTagRouter([{ name: "x", tag: "dev" }])).toThrow(/invalid role tag/);
    expect(() => createRoleTagRouter([{ name: "a", tag: "[a]" }, { name: "n" }])).not.toThrow();
  });
});

describe("pipeline", () => {
  const deps = { lexicon: loadLexicon(), tagRouter: router };
  const run = (text: string) => runIntentPipeline({ text }, deps);
  test("L1: a leading tag decides; the same words without a tag do not", () => {
    const r = run("[dev] add a retry");
    expect(r.decidedBy).toBe("L1");
    expect(r.route).toEqual({ kind: "role", role: "dev", via: "tag" });
    expect(r.ruleIds).toEqual(["tag:dev"]);
    expect(run("dev, add a retry").decidedBy).toBe("none");
  });
  test("L2 is always computed and never decides", () => {
    const r = run("[dev] phân tích kỹ rồi fix bug này");
    expect(r.decidedBy).toBe("L1");
    expect(r.effort.minEffort).toBe("high");
    const n = run("kiến trúc hệ thống thế nào");
    expect(n.decidedBy).toBe("none");
    expect(n.route).toBeUndefined();
    expect(n.effort.classHint).toBe("design");
    expect(run("ok").effort.ruleIds).toEqual([]);
  });
  test("undecided: ruleIds empty", () => {
    expect(run("hello")).toMatchObject({ decidedBy: "none", ruleIds: [] });
  });
});

describe("load-lexicon", () => {
  const home = () => mkdtempSync(join(tmpdir(), "lex-"));
  test("default file loads: 8 groups, phrases normalized, file keeps diacritics", () => {
    const lex = loadLexicon();
    expect(lex.groups.map((x) => x.id)).toEqual([
      "reject_previous",
      "quality_complaint",
      "think_carefully",
      "analyze_judge",
      "design_synthesize",
      "verify",
      "many_constraints",
      "want_fast",
    ]);
    expect(lex.groups[0]?.phrases).toContainEqual(["lac", "de"]);
    expect(readFileSync(DEFAULT_LEXICON_FILE, "utf8")).toContain("lạc đề");
  });
  test("no override file = default", () => {
    expect(loadLexicon(home()).groups).toHaveLength(8);
  });
  test("override replaces the default group (no merge) and may add groups", () => {
    const h = home();
    writeFileSync(
      lexiconOverrideFile(h),
      "groups:\n  want_fast:\n    effect: { turnDelta: -1 }\n    phrases: [gấp lắm]\n  extra_group:\n    effect: { lookup: true }\n    phrases: [tra cứu]\n",
    );
    const lex = loadLexicon(h);
    const fast = lex.groups.find((x) => x.id === "want_fast");
    expect(fast?.phrases).toEqual([["gap", "lam"]]);
    expect(lex.groups.map((x) => x.id)).toContain("extra_group");
    expect(lex.groups).toHaveLength(9);
  });
  test("invalid files throw an error naming the path", () => {
    const bad: [string, RegExp][] = [
      ["groups:\n  x:\n    effect: { floorDelta: 9 }\n    phrases: [a]\n", /floorDelta/],
      ["groups:\n  x:\n    effect: {}\n    phrases: []\n", /phrases/],
      ["groups:\n  Bad-Key:\n    effect: {}\n    phrases: [a]\n", /groups\.Bad-Key/],
      ["groups:\n  x:\n    effect: { minEffort: ultra }\n    phrases: [a]\n", /minEffort/],
      ["groups:\n  x:\n    effect: {}\n    phrases: ['!!!']\n", /empty phrase/],
      ["groups: [unclosed\n", /intent-lexicon/],
      ["unknown: 1\n", /intent-lexicon/],
    ];
    for (const [yaml, re] of bad) {
      const h = home();
      writeFileSync(lexiconOverrideFile(h), yaml);
      expect(() => loadLexicon(h)).toThrow(re);
      expect(() => loadLexicon(h)).toThrow(lexiconOverrideFile(h));
    }
  });
});

/**
 * Only the L3 Haiku classifier talks to the SDK (the one SDK call outside runtime/ besides memory compaction):
 * it may import the runtime's child-env builder (provider credentials + env allowlist), nothing else from runtime/.
 */
const RUNTIME_ALLOW: Record<string, string[]> = {
  "haiku-intent-classifier.ts": ["../runtime/sdk-env"],
};

test("layering: src/intent imports no orchestrator/engine and no runtime/ (except the allow-list)", () => {
  const files = readdirSync("src/intent").filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) {
    const text = readFileSync(join("src/intent", f), "utf8");
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
      (m) => m[1] as string,
    );
    const bad = specs.filter((s) => /orchestrator\/engine|(^|\/)runtime\//.test(s));
    expect(bad.filter((s) => !(RUNTIME_ALLOW[f] ?? []).includes(s))).toEqual([]);
  }
});

/** Direct SDK imports of a source file. */
const sdkImporters = (dir: string): string[] =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /claude-agent-sdk/.test(readFileSync(join(dir, f), "utf8")));

test("layering: only the L3 classifier calls the SDK in intent/; routing (thread/, dispatch/, intent-turn) never does", () => {
  // The allow-list entry must be real (a stale one would hide a future import).
  expect(sdkImporters("src/intent")).toEqual(["haiku-intent-classifier.ts"]);
  expect(readFileSync("src/intent/haiku-intent-classifier.ts", "utf8")).toContain(
    '"../runtime/sdk-env"',
  );
  for (const dir of ["src/orchestrator/thread", "src/orchestrator/dispatch"])
    expect(sdkImporters(dir)).toEqual([]);
  for (const f of ["intent-turn.ts", "route-and-run.ts"])
    expect(readFileSync(join("src/orchestrator", f), "utf8")).not.toMatch(/claude-agent-sdk/);
});

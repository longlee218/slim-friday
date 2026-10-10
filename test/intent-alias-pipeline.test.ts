import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAliasRouter } from "../src/intent/alias-router";
import { matchGateAnswer } from "../src/intent/gate-answer";
import { DEFAULT_LEXICON_FILE, lexiconOverrideFile, loadLexicon } from "../src/intent/load-lexicon";
import { runIntentPipeline } from "../src/intent/run-intent-pipeline";
import { ROLES } from "../src/roles/role-registry";

const realRoles = Object.values(ROLES);
const router = createAliasRouter(realRoles);
const route = (text: string, idle = true) => router.route(text, idle);

describe("alias router (real registry data)", () => {
  test("registry aliases pass validation (no duplicate strong phrase or tag)", () => {
    expect(() => createAliasRouter(realRoles)).not.toThrow();
  });
  test("unique strong alias routes, accented or not", () => {
    for (const t of [
      "giao cho dev nhé",
      "Code đi",
      "code di",
      "sửa code giúp",
      "fix bug login",
      "lập trình viên ơi",
      "implement this",
      "làm task này",
    ]) {
      const d = route(t);
      expect(d.decided && d.role).toBe("dev");
    }
  });
  test("weak assistant alias routes on an idle thread only", () => {
    const idle = route("giải thích giúp", true);
    expect(idle.decided && idle.role).toBe("assistant");
    expect(idle.decided && idle.via).toBe("weak");
    expect(route("giải thích giúp", false).decided).toBe(false);
    expect(route("tại sao lỗi này", true).decided).toBe(true);
    expect(route("tai sao loi nay", false).decided).toBe(false);
  });
  test("several roles match = undecided", () => {
    const d = route("giải thích giúp fix bug này", true); // assistant weak + dev strong
    expect(d.decided).toBe(false);
    expect(!d.decided && d.roles.sort()).toEqual(["assistant", "dev"]);
    // non-idle: the weak one is ignored, dev strong decides alone
    expect(route("giải thích giúp fix bug này", false).decided).toBe(true);
  });
  test("prefix tag always wins, even over a strong alias of another role", () => {
    const d = route("[ask] fix bug này là gì", false);
    expect(d.decided && d.role).toBe("assistant");
    expect(d.decided && d.via).toBe("prefix");
    const e = route("  [DEV] hỏi chút", true);
    expect(e.decided && e.role).toBe("dev");
  });
  test("negation, code and quoted text do not route", () => {
    expect(route("đừng code đi").decided).toBe(false);
    expect(route("không fix bug").decided).toBe(false);
    expect(route("xem `fix bug` trong log").decided).toBe(false);
    expect(route("```\nfix bug\n```").decided).toBe(false);
    expect(route("hello there").decided).toBe(false);
  });
  test("duplicate strong phrase across roles, duplicate or bad tags = error", () => {
    const a = { name: "a", aliases: { tag: "[a]", strong: ["Review giúp"] } };
    const b = { name: "b", aliases: { tag: "[b]", strong: ["review giup"] } };
    expect(() => createAliasRouter([a, b])).toThrow(/strong alias of roles a and b/);
    expect(() =>
      createAliasRouter([a, { name: "c", aliases: { tag: "[A]", strong: [] } }]),
    ).toThrow(/tag/);
    expect(() => createAliasRouter([{ name: "x", aliases: { tag: "dev", strong: [] } }])).toThrow(
      /invalid alias tag/,
    );
    // a strong phrase of one role may be weak in another and roles without aliases are fine
    expect(() =>
      createAliasRouter([
        a,
        { name: "n" },
        { name: "w", aliases: { tag: "[w]", strong: [], weak: ["review giup"] } },
      ]),
    ).not.toThrow();
  });
});

describe("gate answer (L1)", () => {
  const g = (
    text: string,
    state: Parameters<typeof matchGateAnswer>[0]["state"],
    pendingAsk = false,
  ) => matchGateAnswer({ text, state, pendingAsk });
  test("yes / no only while a gate or ask is pending", () => {
    expect(g("ok", "awaiting_plan_approval")?.answer).toBe("yes");
    expect(g("Duyệt nhé", "awaiting_result")).toMatchObject({ answer: "yes", target: "gate" });
    expect(g("không", "awaiting_confirmation")?.answer).toBe("no");
    expect(g("khong", "running", true)).toMatchObject({ answer: "no", target: "ask" });
    expect(g("ok", "idle")).toBeUndefined();
    expect(g("ok", "running")).toBeUndefined();
  });
  test("whole message only: feedback and negated answers fall through", () => {
    expect(g("ok nhưng đổi tên hàm", "awaiting_plan_approval")).toBeUndefined();
    expect(g("không ok", "awaiting_plan_approval")).toBeUndefined();
    expect(g("code di", "awaiting_plan_approval")?.answer).toBe("yes");
    expect(g("", "awaiting_plan_approval")).toBeUndefined();
  });
});

describe("pipeline", () => {
  const deps = { lexicon: loadLexicon(), aliasRouter: router };
  const run = (
    text: string,
    state: Parameters<typeof matchGateAnswer>[0]["state"],
    pendingAsk = false,
  ) => runIntentPipeline({ text, state, pendingAsk }, deps);
  test("L1 before L3: plan waiting + 'code di' = approve, not a dev route", () => {
    const r = run("code đi", "awaiting_plan_approval");
    expect(r.decidedBy).toBe("L1");
    expect(r.route).toEqual({ kind: "gate-answer", answer: "yes", target: "gate" });
    // same text on an idle thread is the dev alias
    const idle = run("code đi", "idle");
    expect(idle.decidedBy).toBe("L3");
    expect(idle.route).toEqual({ kind: "role", role: "dev", via: "strong" });
  });
  test("L2 is always computed and never decides", () => {
    const r = run("phân tích kỹ rồi fix bug này", "idle");
    expect(r.decidedBy).toBe("L3");
    expect(r.effort.minEffort).toBe("high");
    const n = run("kiến trúc hệ thống thế nào", "idle");
    expect(n.decidedBy).toBe("none");
    expect(n.route).toBeUndefined();
    expect(n.effort.classHint).toBe("design");
    expect(run("ok", "awaiting_result").effort.ruleIds).toEqual([]);
  });
  test("undecided: nothing or ambiguous; ruleIds list ambiguous hits", () => {
    expect(run("hello", "idle")).toMatchObject({ decidedBy: "none", ruleIds: [] });
    expect(run("giải thích fix bug này", "idle")).toMatchObject({
      decidedBy: "none",
      ruleIds: ["alias:assistant:weak", "alias:dev:strong"],
    });
  });
  test("running thread: weak aliases never decide", () => {
    expect(run("tại sao lỗi", "running").decidedBy).toBe("none");
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

test("layering: src/intent imports no orchestrator/engine and no runtime/", () => {
  const files = readdirSync("src/intent").filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) {
    const text = readFileSync(join("src/intent", f), "utf8");
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
      (m) => m[1] as string,
    );
    expect(specs.filter((s) => /orchestrator\/engine|(^|\/)runtime\//.test(s))).toEqual([]);
  }
});

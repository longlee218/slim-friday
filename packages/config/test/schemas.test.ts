import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitFrontMatter } from "../src/parse/front-matter";
import { isUploadAvatar } from "../src/schemas/avatar";
import { parseBotFile } from "../src/schemas/bot-file";
import { parseGroupFile } from "../src/schemas/group-file";
import { parseSettingsFile } from "../src/schemas/settings-file";
import { parseToolsFile } from "../src/schemas/tools-file";

const BOT = `---
name: Ann
title: Developer
model: sonnet
tools: [Read, Bash]
workspaces: ["~/code/app", /srv/data]
autonomy: careful
subagents:
  - name: helper
    description: reads files
    prompt: read what you are told
    tools: [Read]
---
Be brief.
Ask before big changes.
`;

test("splitFrontMatter splits data and body, and refuses a file without it", () => {
  expect(splitFrontMatter("---\na: 1\n---\nbody\n")).toEqual({ data: "a: 1", body: "body" });
  expect(() => splitFrontMatter("no header")).toThrow("missing front matter");
});

test("a full bot file parses into a Bot", () => {
  expect(parseBotFile("ann", BOT)).toEqual({
    id: "ann",
    name: "Ann",
    title: "Developer",
    instructions: "Be brief.\nAsk before big changes.",
    model: "sonnet",
    tools: ["Read", "Bash"],
    skills: [],
    subagents: [
      {
        name: "helper",
        description: "reads files",
        prompt: "read what you are told",
        tools: ["Read"],
      },
    ],
    workspaces: [join(homedir(), "code/app"), "/srv/data"],
    autonomy: "careful",
  });
});

const bad =
  (edit: (s: string) => string, id = "ann") =>
  () =>
    parseBotFile(id, edit(BOT));

test("a bot file with a problem is refused", () => {
  expect(bad((s) => s.replace("model: sonnet", "model: sonnet\nextra: 1"))).toThrow();
  expect(bad((s) => s.replace('"~/code/app"', "code/app"))).toThrow();
  expect(bad((s) => s.replace(/Be brief\.\nAsk before big changes\.\n/, ""))).toThrow();
  expect(
    bad((s) =>
      s.replace("subagents:", "subagents:\n  - name: helper\n    description: d\n    prompt: p"),
    ),
  ).toThrow();
  expect(bad((s) => s, "Bad_Id")).toThrow();
  expect(bad((s) => s.replace("name: Ann", "name: Ann Lee"))).toThrow();
});

test("a group file parses; an entry bot outside the members is refused", () => {
  expect(parseGroupFile("team", "name: Team\nmembers: [ann, bob]\nentryBot: ann\n")).toEqual({
    id: "team",
    name: "Team",
    members: ["ann", "bob"],
    entryBot: "ann",
    workspaces: [],
    instructions: "",
  });
  expect(() => parseGroupFile("team", "name: Team\nmembers: [ann]\nentryBot: bob\n")).toThrow();
  expect(() => parseGroupFile("team", "name: T\nmembers: [ann, ann]\nentryBot: ann\n")).toThrow();
});

test("a settings file parses; bad limits and outcomes are refused", () => {
  const ok = parseSettingsFile(
    "autonomy:\n  level: careful\n  bots: {ann: autonomous}\n  tools: {Bash: ask}\nlimits:\n  maxHops: 3\n",
  );
  expect(ok.autonomy?.level).toBe("careful");
  expect(ok.limits).toEqual({ maxHops: 3 });
  expect(() => parseSettingsFile("limits:\n  maxHops: 0\n")).toThrow();
  expect(() => parseSettingsFile("limits:\n  nope: 1\n")).toThrow();
  // The tool-call cap may be 0 (off), never negative.
  expect(parseSettingsFile("limits:\n  maxToolCallsPerTurn: 0\n").limits).toEqual({
    maxToolCallsPerTurn: 0,
  });
  expect(() => parseSettingsFile("limits:\n  maxToolCallsPerTurn: -1\n")).toThrow();
  expect(() => parseSettingsFile("autonomy:\n  tools: {Bash: maybe}\n")).toThrow();
});

test("a tools file parses; duplicate names are refused", () => {
  const ok = parseToolsFile(
    "tools:\n  - name: Read\n    annotations: {readOnlyHint: true}\n  - name: Bash\n    sandboxed: true\n    scopeKeys: [cwd]\n",
  );
  expect(ok).toEqual([
    { name: "Read", annotations: { readOnlyHint: true } },
    { name: "Bash", sandboxed: true, scopeKeys: ["cwd"] },
  ]);
  expect(() => parseToolsFile("tools:\n  - name: A\n  - name: A\n")).toThrow();
});

test("a bot file may name an avatar; a path-like avatar is refused", () => {
  const file = (avatar: string) =>
    `---\nname: Ann\ntitle: T\nmodel: m\navatar: ${avatar}\n---\nBe brief.`;
  expect(parseBotFile("ann", file("developer")).avatar).toBe("developer");
  expect(parseBotFile("ann", "---\nname: Ann\ntitle: T\nmodel: m\n---\nx").avatar).toBeUndefined();
  for (const bad of ["../x", "a/b", ".hidden", "x.png"])
    expect(() => parseBotFile("ann", file(bad))).toThrow();
});

test("effort and maxEffort parse; a ceiling under the start level and an unknown level are refused", () => {
  const withHeader = (extra: string) =>
    `---\nname: Ann\ntitle: Dev\nmodel: sonnet\n${extra}\n---\nBe brief.\n`;
  const bot = parseBotFile("ann", withHeader("effort: low\nmaxEffort: xhigh"));
  expect(bot.effort).toBe("low");
  expect(bot.maxEffort).toBe("xhigh");
  expect(() => parseBotFile("ann", withHeader("effort: high\nmaxEffort: low"))).toThrow();
  expect(() => parseBotFile("ann", withHeader("effort: extreme"))).toThrow();
  const sub = withHeader("subagents:\n  - {name: h, description: d, prompt: p, effort: max}");
  expect(parseBotFile("ann", sub).subagents[0]?.effort).toBe("max");
});

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const botWith = (avatar: string) =>
  BOT.replace("autonomy: careful", `autonomy: careful\navatar: ${avatar}`);

test("a bot avatar may be a preset name or upload:<uuid>; other values are refused", () => {
  expect(parseBotFile("ann", botWith(`upload:${UUID}`)).avatar).toBe(`upload:${UUID}`);
  expect(parseBotFile("ann", botWith("fox")).avatar).toBe("fox");
  for (const bad of ["upload:../x", "../a.png", "upload:"]) {
    expect(() => parseBotFile("ann", botWith(bad))).toThrow();
  }
});

test("a group avatar passes through; without one the group has none", () => {
  const base = "name: Team\nmembers: [ann]\nentryBot: ann\n";
  expect(parseGroupFile("team", `${base}avatar: hedgehog-3\n`).avatar).toBe("hedgehog-3");
  expect(parseGroupFile("team", base)).not.toHaveProperty("avatar");
  expect(() => parseGroupFile("team", `${base}avatar: ../a\n`)).toThrow();
});

test("isUploadAvatar returns the upload id or undefined", () => {
  expect(isUploadAvatar(`upload:${UUID}`)).toBe(UUID);
  expect(isUploadAvatar("fox")).toBeUndefined();
});

test("a bot description round-trips through the parser, is optional and is capped at 500 chars", () => {
  const text = (extra: string) => `---\nname: Ann\ntitle: Dev\nmodel: m\n${extra}---\nBe brief.\n`;
  expect(parseBotFile("ann", text("description: Reviews code.\n")).description).toBe(
    "Reviews code.",
  );
  expect(parseBotFile("ann", text("")).description).toBeUndefined();
  expect(() => parseBotFile("ann", text(`description: ${"x".repeat(501)}\n`))).toThrow();
});

test("limits.toolSearch accepts on, off and auto:<1-100>; anything else is refused", () => {
  for (const v of ["on", "off", "auto:1", "auto:5", "auto:100"])
    expect(parseSettingsFile(`limits:\n  toolSearch: ${v}\n`).limits).toEqual({ toolSearch: v });
  for (const v of ["auto:0", "auto:101", "auto:", "maybe", "true", "5"])
    expect(() => parseSettingsFile(`limits:\n  toolSearch: ${v}\n`)).toThrow();
});

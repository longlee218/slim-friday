import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitFrontMatter } from "../src/parse/front-matter";
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

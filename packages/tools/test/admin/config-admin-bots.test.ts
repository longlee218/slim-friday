import { beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBotFile, parseGroupFile } from "@friday/config";
import type { BotInput, ConfigAdmin, GroupInput } from "@friday/core";
import { createConfigAdmin } from "../../src/admin/config-admin";
import { setup } from "../design-fixture";

const dev: BotInput = {
  id: "dev",
  name: "Dev",
  title: "developer",
  model: "sonnet",
  instructions: "Write code.",
  tools: ["Read"],
  skills: [],
  workspaces: [],
};
const U1 = "11111111-1111-4111-8111-111111111111";

let home: string;
let configDir: string;
let admin: ConfigAdmin;

/** Ids of the *.md / *.yaml files in a config sub dir, read from disk (the real app reads its live snapshot). */
const idsIn = (dir: string, ext: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(ext))
        .map((f) => f.slice(0, -ext.length))
    : [];

beforeEach(() => {
  const s = setup();
  ({ home, configDir } = s);
  const groupFiles = () =>
    idsIn(join(configDir, "groups"), ".yaml").flatMap((id) => {
      try {
        return [parseGroupFile(id, readFileSync(join(configDir, "groups", `${id}.yaml`), "utf8"))];
      } catch {
        return []; // the app's snapshot also leaves a broken file out
      }
    });
  admin = createConfigAdmin({
    ...s.ctx,
    // The real parsers, as the app wires them.
    checkBot: (id, text) => void parseBotFile(id, text),
    checkGroup: (id, text) => void parseGroupFile(id, text),
    botSummaries: () => [
      { id: "friday", name: "Friday", title: "" },
      ...idsIn(join(configDir, "bots"), ".md").map((id) => ({ id, name: id, title: "" })),
    ],
    groupSummaries: groupFiles,
    presetAvatars: () => ["fox", "owl"],
    readBotFile: (id) => {
      for (const d of s.ctx.botDirs) {
        const f = join(d, `${id}.md`);
        if (existsSync(f)) return readFileSync(f, "utf8");
      }
      return undefined;
    },
  });
});

/** An ok team: dev and ann, plus a group. */
const group: GroupInput = {
  id: "team",
  name: "Team",
  members: ["dev"],
  entryBot: "dev",
  workspaces: [],
  instructions: "Work together.",
};

test("refuses an id that leaves the config dir", () => {
  expect(() => admin.saveBot({ ...dev, id: "../evil" }, "create")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST", field: "id" }),
  );
  expect(existsSync(join(home, "evil.md"))).toBe(false);
});

test("refuses a write through a symlinked bots dir", () => {
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  rmSync(join(configDir, "bots"), { recursive: true });
  symlinkSync(outside, join(configDir, "bots"));
  expect(() => admin.saveBot(dev, "create")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );
  expect(readdirSync(outside)).toEqual([]);
});

test("refuses a write through a symlinked groups dir", () => {
  admin.saveBot(dev, "create");
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  rmSync(join(configDir, "groups"), { recursive: true });
  symlinkSync(outside, join(configDir, "groups"));
  expect(() => admin.saveGroup(group, "create")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );
  expect(readdirSync(outside)).toEqual([]);
});

test("parser message comes back on the field", () => {
  expect(() => admin.saveBot({ ...dev, name: "at@sign" }, "create")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST", field: "name" }),
  );
  expect(() => admin.saveBot({ ...dev, name: "Dev", tools: ["Nope"] }, "create")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST", field: "tools" }),
  );
});

test("shipped friday is read only", () => {
  expect(admin.getBot("friday").shipped).toBe(true);
  expect(() => admin.saveBot({ ...admin.getBot("friday"), title: "x" }, "update")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );
  expect(() => admin.deleteBot("friday")).toThrow(expect.objectContaining({ code: "BAD_REQUEST" }));
  expect(() => admin.setAvatar({ kind: "bot", id: "friday" }, "fox")).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );
});

test("getBot returns the file body, not SOUL + USER + body", () => {
  writeFileSync(join(configDir, "USER.md"), "I am the owner");
  admin.saveBot(dev, "create");
  const got = admin.getBot("dev");
  expect(got.instructions).toBe(dev.instructions);
  expect(got.shipped).toBe(false);
  expect(readFileSync(join(configDir, "bots", "dev.md"), "utf8")).not.toContain("I am the owner");
  expect(admin.listBots().map((b) => b.id)).toEqual(["dev", "friday"]);
});

test("create on existing is CONFLICT, update on missing is NOT_FOUND", () => {
  expect(() => admin.saveBot(dev, "update")).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  admin.saveBot(dev, "create");
  expect(() => admin.saveBot(dev, "create")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  expect(() => admin.getBot("ghost")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
  admin.saveBot({ ...dev, title: "lead" }, "update");
  expect(admin.getBot("dev").title).toBe("lead");
});

test("deleting a group member is CONFLICT naming the group", () => {
  admin.saveBot(dev, "create");
  admin.saveGroup(group, "create");
  expect(() => admin.deleteBot("dev")).toThrow(
    expect.objectContaining({ code: "CONFLICT", message: expect.stringContaining("team") }),
  );
  expect(existsSync(join(configDir, "bots", "dev.md"))).toBe(true);
});

test("deleteBot moves the file to the 7-day trash", () => {
  admin.saveBot(dev, "create");
  admin.deleteBot("dev");
  expect(existsSync(join(configDir, "bots", "dev.md"))).toBe(false);
  expect(existsSync(join(home, "trash"))).toBe(true);
  expect(() => admin.deleteBot("dev")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
});

test("owner may set autonomy autonomous; subagents survive a save", () => {
  admin.saveBot(dev, "create");
  const file = join(configDir, "bots", "dev.md");
  const text = readFileSync(file, "utf8").replace(
    /^skills:[\s\S]*?\n(?=\w)/m,
    "skills: []\nsubagents:\n  - name: helper\n    description: helps\n    prompt: help\n",
  );
  writeFileSync(file, text);
  admin.saveBot({ ...dev, autonomy: "autonomous", tools: ["Read", "Agent"] }, "update");
  const parsed = parseBotFile("dev", readFileSync(file, "utf8"));
  expect(parsed.autonomy).toBe("autonomous");
  expect(parsed.subagents.map((s) => s.name)).toEqual(["helper"]);
});

test("a save keeps the avatar; only setAvatar changes it", () => {
  admin.saveBot(dev, "create");
  admin.setAvatar({ kind: "bot", id: "dev" }, `upload:${U1}`);
  admin.saveBot({ ...dev, title: "lead" }, "update");
  expect(admin.getBot("dev").avatar).toBe(`upload:${U1}`);
});

test("setAvatar returns the previous value and writes upload:<id>", () => {
  admin.saveBot(dev, "create");
  expect(admin.setAvatar({ kind: "bot", id: "dev" }, `upload:${U1}`)).toEqual({});
  expect(admin.getBot("dev").avatar).toBe(`upload:${U1}`);
  expect(admin.setAvatar({ kind: "bot", id: "dev" }, "fox")).toEqual({ previous: `upload:${U1}` });
  expect(admin.setAvatar({ kind: "bot", id: "dev" }, null)).toEqual({ previous: "fox" });
  expect(admin.getBot("dev").avatar).toBeUndefined();
  expect(readFileSync(join(configDir, "bots", "dev.md"), "utf8")).toContain("Write code.");
});

test("setAvatar refuses an unknown preset and a path-like value", () => {
  admin.saveBot(dev, "create");
  for (const bad of ["dragon", "../x", "upload:../../x"])
    expect(() => admin.setAvatar({ kind: "bot", id: "dev" }, bad)).toThrow(
      expect.objectContaining({ code: "BAD_REQUEST" }),
    );
  expect(admin.presets()).toEqual(["fox", "owl"]);
});

test("groups: create, get, update keeps avatar, bad member, avatar, delete to trash", () => {
  admin.saveBot(dev, "create");
  expect(() =>
    admin.saveGroup({ ...group, members: ["ghost"], entryBot: "ghost" }, "create"),
  ).toThrow(expect.objectContaining({ code: "BAD_REQUEST", field: "members" }));
  admin.saveGroup(group, "create");
  expect(() => admin.saveGroup(group, "create")).toThrow(
    expect.objectContaining({ code: "CONFLICT" }),
  );
  expect(() => admin.saveGroup({ ...group, id: "nope" }, "update")).toThrow(
    expect.objectContaining({ code: "NOT_FOUND" }),
  );
  admin.setAvatar({ kind: "group", id: "team" }, `upload:${U1}`);
  admin.saveGroup({ ...group, name: "Crew" }, "update");
  expect(admin.getGroup("team")).toMatchObject({ name: "Crew", avatar: `upload:${U1}` });
  expect(admin.listGroups().map((g) => g.id)).toEqual(["team"]);
  expect(admin.setAvatar({ kind: "group", id: "team" }, null)).toEqual({
    previous: `upload:${U1}`,
  });
  admin.deleteGroup("team");
  expect(existsSync(join(configDir, "groups", "team.yaml"))).toBe(false);
  expect(() => admin.getGroup("team")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
});

test("a broken group file does not lock lists, deleteBot or deleteGroup", () => {
  admin.saveBot(dev, "create");
  admin.saveBot({ ...dev, id: "ann", name: "Ann" }, "create");
  admin.saveGroup(group, "create");
  writeFileSync(join(configDir, "groups", "x.yaml"), "name: [unclosed\n  members: {");
  expect(admin.listGroups().map((g) => g.id)).toEqual(["team"]);
  admin.deleteBot("ann");
  expect(() => admin.deleteBot("dev")).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  admin.deleteGroup("x");
  expect(existsSync(join(configDir, "groups", "x.yaml"))).toBe(false);
});

test("a broken or oddly named bot file does not break listBots", () => {
  admin.saveBot(dev, "create");
  writeFileSync(join(configDir, "bots", "My-Bot.md"), "---\nname: x\n---\nbody\n");
  writeFileSync(join(configDir, "bots", "bad.md"), "---\nname: [unclosed\n  tools: {\n---\nbody\n");
  expect(admin.listBots().map((b) => b.id)).toEqual(["dev", "friday"]);
});

test("extra runtime keys on the input do not get through", () => {
  admin.saveBot(dev, "create");
  admin.setAvatar({ kind: "bot", id: "dev" }, "fox");
  admin.saveBot({ ...dev, avatar: "owl", subagents: [] } as unknown as BotInput, "update");
  expect(admin.getBot("dev").avatar).toBe("fox");
  admin.saveGroup(group, "create");
  admin.setAvatar({ kind: "group", id: "team" }, "fox");
  admin.saveGroup({ ...group, avatar: "owl" } as unknown as GroupInput, "update");
  expect(admin.getGroup("team").avatar).toBe("fox");
});

test("cascade delete: a one-member group goes, an entry bot is replaced, then the bot goes", () => {
  admin.saveBot(dev, "create");
  admin.saveBot({ ...dev, id: "ann", name: "Ann" }, "create");
  admin.saveGroup({ ...group, id: "solo", name: "Solo" }, "create");
  admin.saveGroup({ ...group, members: ["dev", "ann"] }, "create");
  admin.deleteBot("dev", { cascade: true });
  expect(existsSync(join(configDir, "groups", "solo.yaml"))).toBe(false);
  expect(admin.getGroup("team")).toMatchObject({ members: ["ann"], entryBot: "ann" });
  expect(existsSync(join(configDir, "bots", "dev.md"))).toBe(false);
});

test("cascade delete of a shipped bot is refused before any group changes", () => {
  expect(() => admin.deleteBot("friday", { cascade: true })).toThrow(
    expect.objectContaining({ code: "BAD_REQUEST" }),
  );
});

test("deletable: true for an owner bot, false for a shipped one", () => {
  admin.saveBot(dev, "create");
  expect(admin.getBot("dev").deletable).toBe(true);
  expect(admin.getBot("friday").deletable).toBe(false);
});

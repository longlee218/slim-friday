import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import { workspacePaths } from "../src/config/workspace-paths";
import { createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { checkToolCall, guardFor } from "../src/guardrails/check-tool-call";
import { validateIntent } from "../src/intent/intent-schema";
import { mcpServersFor } from "../src/mcp/mcp-servers";
import {
  APP_MCP_TOOLS,
  DISCORD_ADMIN_MCP_SERVER,
  mcpToolName,
  WRITE_SPACE_FILE_TOOL,
} from "../src/mcp/mcp-tool-names";
import { roleScope } from "../src/orchestrator/engine/role-scope";
import { stripRoleTag } from "../src/orchestrator/thread/intent-replies";
import { DISCORD_MANAGER_ROLE } from "../src/roles/builtin/discord-manager-role";
import {
  mayHaveWritten,
  rerouteCandidates,
  validateRegistry,
} from "../src/roles/capability-registry";
import {
  controlRole,
  dispatchableRoleNames,
  getRole,
  intentRoles,
  spaceRoles,
} from "../src/roles/role-registry";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";
import { createCreateSpaceOrChannelTool } from "../src/tools/CreateSpaceOrChannelTool/create-space-or-channel-tool";
import {
  BASH_TOOL_NAME,
  READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { toolsFor } from "../src/tools/tool-catalog";
import { fakeGuild } from "./fake-guild";
import { assertTempHome, makeEnv } from "./helpers";

const NAME = DISCORD_MANAGER_ROLE.name;

test("role data: control surface, cheap, read + skills + ask only, own limits", () => {
  expect(controlRole()).toBe(DISCORD_MANAGER_ROLE);
  expect(DISCORD_MANAGER_ROLE).toMatchObject({
    surface: "control",
    background: false,
    model: "haiku",
    capabilities: ["read", "skills", "ask"],
    gitGroups: [],
    mcpServers: [DISCORD_ADMIN_MCP_SERVER],
    limits: { maxAsk: 4 },
    sideEffects: "external",
    approvalRequired: true,
  });
  const tools = toolsFor(DISCORD_MANAGER_ROLE);
  for (const t of [WRITE_TOOL_NAME, BASH_TOOL_NAME, WEB_FETCH_TOOL_NAME])
    expect(tools).not.toContain(t);
});

test("the role is never offered to a space channel: intent, dispatch, reroute, Jev, a model-picked name", () => {
  expect(intentRoles().map((r) => r.name)).not.toContain(NAME);
  expect(dispatchableRoleNames()).not.toContain(NAME);
  expect(spaceRoles().map((r) => r.name)).not.toContain(NAME);
  expect(rerouteCandidates({ visited: [], hasApprovals: true })).not.toContain(NAME);
  expect(validateIntent({ role: NAME } as never, { hasTask: false })).toEqual({
    ok: false,
    reason: "unknown_role",
  });
  // The registry still knows it (the control runner finds it by `surface`).
  expect(getRole(NAME)).toBe(DISCORD_MANAGER_ROLE);
});

test("the guard allows exactly the role's app tools; other roles and unknown tools are denied", () => {
  const guard = guardFor(DISCORD_MANAGER_ROLE, {});
  for (const t of APP_MCP_TOOLS[DISCORD_ADMIN_MCP_SERVER] ?? [])
    expect(checkToolCall(mcpToolName(DISCORD_ADMIN_MCP_SERVER, t), {}, guard).decision).toBe(
      "allow",
    );
  expect(
    checkToolCall(mcpToolName(DISCORD_ADMIN_MCP_SERVER, "DeleteChannel"), {}, guard).decision,
  ).toBe("deny");
  const assistant = guardFor(getRole("assistant"), {});
  expect(
    checkToolCall(mcpToolName(DISCORD_ADMIN_MCP_SERVER, WRITE_SPACE_FILE_TOOL), {}, assistant)
      .decision,
  ).toBe("deny");
});

test("the admin server is added only when the caller supplies it and the role lists it", () => {
  const server = { type: "sdk", name: DISCORD_ADMIN_MCP_SERVER, instance: {} } as never;
  expect(
    Object.keys(
      mcpServersFor(DISCORD_MANAGER_ROLE, undefined, () => ({
        [DISCORD_ADMIN_MCP_SERVER]: server,
      })),
    ),
  ).toEqual([DISCORD_ADMIN_MCP_SERVER]);
  expect(Object.keys(mcpServersFor(DISCORD_MANAGER_ROLE))).toEqual([]);
  expect(
    Object.keys(
      mcpServersFor(getRole("assistant"), undefined, () => ({
        [DISCORD_ADMIN_MCP_SERVER]: server,
      })),
    ),
  ).not.toContain(DISCORD_ADMIN_MCP_SERVER);
});

test("its skill ships with the app, loads without a workspace, and no other role gets it", () => {
  const env = makeEnv();
  const mine = buildRoleSkills(DISCORD_MANAGER_ROLE, undefined, env.home);
  try {
    expect(mine.skills).toHaveLength(1);
    expect(mine.skills[0]).toMatch(/^[a-z]+:[a-z-]+$/);
    expect(mine.dirs).toHaveLength(1);
    expect(
      existsSync(join(mine.dirs[0] as string, "skills", "discord-server-manager", "SKILL.md")),
    ).toBe(true);
  } finally {
    mine.cleanup();
  }
  for (const other of ["assistant", "dev"]) {
    const s = buildRoleSkills(getRole(other), undefined, env.home);
    expect(s.skills.some((n) => n.includes("discord-server-manager"))).toBe(false);
    s.cleanup();
  }
});

test("no-workspace scope: control dir, no write path, AGENT_HOME denied but workspaces/ readable", () => {
  const env = makeEnv();
  createWorkspaceDir(env.home, "study"); // spaces are granted as they exist when the run starts
  const s = roleScope(
    env.config,
    {
      turnId: "t",
      threadId: "c",
      text: "hi",
      role: NAME,
      locations: [],
      ac: new AbortController(),
    },
    DISCORD_MANAGER_ROLE,
  );
  expect(s.cwd.endsWith(join("tmp", "control"))).toBe(true);
  expect(s.guard.writePaths).toBeUndefined();
  expect(s.scope).toEqual([]);
  const guard = guardFor(DISCORD_MANAGER_ROLE, s.guard);
  const read = (p: string) => checkToolCall(READ_TOOL_NAME, { file_path: p }, guard).decision;
  const write = (p: string) => checkToolCall(WRITE_TOOL_NAME, { file_path: p }, guard).decision;
  expect(read(join(env.home, "workspaces", "study", "SOUL.md"))).toBe("allow");
  expect(read(join(env.home, "workspaces", "study", "workspace.yaml"))).toBe("allow");
  expect(read(join(env.home, "workspaces", "study", "channels", "study-agent", "MEMORY.md"))).toBe(
    "allow",
  );
  // tasks, cwd and locations of a space are not granted
  for (const dir of ["tasks", "cwd", "locations"])
    expect(read(join(env.home, "workspaces", "study", dir, "x.txt"))).toBe("deny");
  // AGENT_HOME secrets and the db stay unreadable; nothing is writable anywhere.
  expect(read(workspacePaths(env.home).dbFile)).toBe("deny");
  expect(read(join(env.home, ".env"))).toBe("deny");
  expect(read(join(env.home, "logs", "x.jsonl"))).toBe("deny");
  expect(write(join(env.home, "workspaces", "study", "SOUL.md"))).toBe("deny");
  expect(write(join(s.cwd, "x.txt"))).toBe("deny");
});

test("CreateSpaceOrChannel: same parser and create-only refusals as the commands", async () => {
  const home = mkdtempSync(join(tmpdir(), "friday-csc-"));
  assertTempHome(home);
  const g = fakeGuild([]);
  const tool = createCreateSpaceOrChannelTool({
    home,
    init: { home, guild: g.guild, ids: { guildId: "G1", ownerId: "2", botId: "3" } },
    confirm: async () => true,
  });
  const call = async (a: Record<string, string>) => {
    const r = await tool.handler(a as never, {});
    return { text: (r.content[0] as { text: string }).text, isError: !!r.isError };
  };
  expect((await call({ space: "../x" })).isError).toBe(true);
  expect((await call({ space: "ops" })).isError).toBe(true); // reserved
  expect((await call({ space: "english", channel: "a/b" })).isError).toBe(true);
  expect(g.created).toHaveLength(0);
  const made = await call({ space: "english" });
  expect(made.text).toContain("Created private category");
  expect(g.created.map((c) => c.type)).toEqual([ChannelType.GuildCategory, ChannelType.GuildText]);
  // a second create of the same space refuses and creates nothing more
  expect((await call({ space: "english" })).text).toContain("already set up");
  expect(g.created).toHaveLength(2);
  // a channel of a missing space is refused; one of the new space is created
  expect((await call({ space: "ghost", channel: "notes" })).text).toContain("not set up");
  expect((await call({ space: "english", channel: "notes" })).text).toContain("Created private");
});

test("CreateSpaceOrChannel asks the owner first; a no, a timeout (false) or an error creates nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "friday-csc2-"));
  assertTempHome(home);
  const g = fakeGuild([]);
  const asked: string[] = [];
  let answer: () => Promise<boolean> = async () => true;
  const tool = createCreateSpaceOrChannelTool({
    home,
    init: { home, guild: g.guild, ids: { guildId: "G1", ownerId: "2", botId: "3" } },
    confirm: async (q) => {
      asked.push(q.summary);
      return answer();
    },
  });
  const call = async (a: Record<string, string>) =>
    ((await tool.handler(a as never, {})).content[0] as { text: string }).text;
  answer = async () => false;
  expect(await call({ space: "english" })).toContain("not created");
  answer = async () => {
    throw new Error("relay down");
  };
  expect(await call({ space: "english" })).toContain("not created");
  expect(g.created).toHaveLength(0);
  answer = async () => true;
  await call({ space: "english" });
  expect(g.created).toHaveLength(2);
  await call({ space: "english", channel: "notes" });
  expect(asked).toEqual([
    "Create space english",
    "Create space english",
    "Create space english",
    "Create channel english/notes",
  ]);
});

test("a role that may cause external side effects is never re-run automatically", () => {
  expect(mayHaveWritten(DISCORD_MANAGER_ROLE)).toBe(true); // no write capability, sideEffects external
  expect(mayHaveWritten(getRole("dev"))).toBe(true);
  expect(mayHaveWritten(getRole("assistant"))).toBe(false);
});

test("tag paths use the space roles; a control role with a tag is rejected", () => {
  const tagged = { ...DISCORD_MANAGER_ROLE, tag: "dm" };
  expect(() => validateRegistry({ [tagged.name]: tagged })).toThrow(
    /control role cannot have a tag/,
  );
  expect(() => validateRegistry()).not.toThrow();
  // the tag router of the intent layer is built from space roles only
  expect(stripRoleTag("[dev] fix it")).toBe("fix it");
  expect(stripRoleTag(`[${NAME}] make a space`)).toBe(`[${NAME}] make a space`);
});

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType } from "discord.js";
import { HAIKU_MODEL } from "../src/config/model-ids";
import { workspacePaths } from "../src/config/workspace-paths";
import { createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { CREATE_SPACE_OR_CHANNEL_TOOL } from "../src/mcp/discord-admin/tools/CreateSpaceOrChannelTool/constants";
import { createCreateSpaceOrChannelTool } from "../src/mcp/discord-admin/tools/CreateSpaceOrChannelTool/create-space-or-channel-tool";
import { LIST_SPACES_TOOL } from "../src/mcp/discord-admin/tools/ListSpacesTool/constants";
import { WRITE_SPACE_FILE_TOOL } from "../src/mcp/discord-admin/tools/WriteSpaceFileTool/constants";
import { buildServers } from "../src/mcp/mcp-servers";
import { DISCORD_ADMIN_MCP_SERVER, mcpToolName } from "../src/mcp/mcp-tool-names";
import { roleScope } from "../src/orchestrator/engine/role-scope";
import { checkToolCall, guardFor } from "../src/policy/check-tool-call";
import { DISCORD_MANAGER_ROLE } from "../src/roles/builtin/discord-manager-role";
import { mayHaveWritten, validateRegistry } from "../src/roles/capability-registry";
import { controlRole, dispatchableWorkers, getRole } from "../src/roles/role-registry";
import { buildRoleSkills } from "../src/runtime/skills-plugin/role-skills";
import {
  BASH_TOOL_NAME,
  READ_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  WRITE_TOOL_NAME,
} from "../src/tools/sdk-tool-names";
import { toolsFor } from "../src/tools/tool-catalog";
import { fakeGuild } from "./fake-guild";
import { assertTempHome, makeEnv } from "./helpers";
import { FULL_CTX, toolsByServer } from "./mcp-ctx-fixture";

const NAME = DISCORD_MANAGER_ROLE.name;

test("role data: control surface, cheap, read + skills + ask only, own limits", () => {
  expect(controlRole()).toBe(DISCORD_MANAGER_ROLE);
  expect(DISCORD_MANAGER_ROLE).toMatchObject({
    surface: "control",
    background: false,
    model: HAIKU_MODEL,
    thinking: { type: "disabled" },
    capabilities: ["read", "skills", "ask"],
    mcpTools: [LIST_SPACES_TOOL, CREATE_SPACE_OR_CHANNEL_TOOL, WRITE_SPACE_FILE_TOOL],
    limits: { maxAsk: 4 },
    sideEffects: "external",
  });
  const tools = toolsFor(DISCORD_MANAGER_ROLE);
  for (const t of [WRITE_TOOL_NAME, BASH_TOOL_NAME, WEB_FETCH_TOOL_NAME])
    expect(tools).not.toContain(t);
});

test("the role is never dispatchable by the lead", () => {
  expect(dispatchableWorkers().map((r) => r.name)).not.toContain(NAME);
  // The registry still knows it (the control runner finds it by `surface`).
  expect(getRole(NAME)).toBe(DISCORD_MANAGER_ROLE);
});

test("the guard allows exactly the role's app tools; other roles and unknown tools are denied", () => {
  const guard = guardFor(DISCORD_MANAGER_ROLE, {});
  for (const t of DISCORD_MANAGER_ROLE.mcpTools ?? [])
    expect(checkToolCall(mcpToolName(DISCORD_ADMIN_MCP_SERVER, t), {}, guard).decision).toBe(
      "allow",
    );
  expect(
    checkToolCall(mcpToolName(DISCORD_ADMIN_MCP_SERVER, "DeleteChannel"), {}, guard).decision,
  ).toBe("deny");
  const lead = guardFor(getRole("lead"), {});
  expect(
    checkToolCall(mcpToolName(DISCORD_ADMIN_MCP_SERVER, WRITE_SPACE_FILE_TOOL), {}, lead).decision,
  ).toBe("deny");
});

test("the admin server is built only when the run has the admin ctx and the role lists its tools", () => {
  expect(toolsByServer(buildServers(DISCORD_MANAGER_ROLE, { admin: FULL_CTX.admin }))).toEqual({
    [DISCORD_ADMIN_MCP_SERVER]: [
      CREATE_SPACE_OR_CHANNEL_TOOL,
      LIST_SPACES_TOOL,
      WRITE_SPACE_FILE_TOOL,
    ].sort(),
  });
  expect(Object.keys(buildServers(DISCORD_MANAGER_ROLE, {}))).toEqual([]);
  expect(Object.keys(buildServers(getRole("lead"), { admin: FULL_CTX.admin }))).not.toContain(
    DISCORD_ADMIN_MCP_SERVER,
  );
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
  for (const other of ["lead", "developer"]) {
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
  expect(mayHaveWritten(getRole("developer"))).toBe(true);
  expect(mayHaveWritten(getRole("lead"))).toBe(false);
});

test("the registry validates", () => {
  expect(() => validateRegistry()).not.toThrow();
});

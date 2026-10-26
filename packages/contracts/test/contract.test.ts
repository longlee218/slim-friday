import { expect, test } from "bun:test";
import { contract, listProcedurePaths, MAX_AVATAR_BYTES } from "../src";

const ALL = [
  "approvals.answer",
  "approvals.pending",
  "chat.file",
  "chat.files",
  "chat.send",
  "chat.uploadCreate",
  "config.approvalRules.add",
  "config.approvalRules.list",
  "config.approvalRules.remove",
  "config.approvalRules.setEffect",
  "config.avatars.create",
  "config.avatars.list",
  "config.bots.delete",
  "config.bots.get",
  "config.bots.list",
  "config.bots.save",
  "config.bots.scratchpad",
  "config.bots.setAvatar",
  "config.groups.delete",
  "config.groups.get",
  "config.groups.list",
  "config.groups.save",
  "config.groups.setAvatar",
  "config.mcp.calls",
  "config.mcp.delete",
  "config.mcp.icon",
  "config.mcp.list",
  "config.mcp.save",
  "config.mcp.signIn",
  "config.mcp.test",
  "config.models.list",
  "config.owner.get",
  "config.owner.save",
  "config.permissions.get",
  "config.permissions.setAutoReview",
  "config.skills.checkUpdate",
  "config.skills.install",
  "config.skills.list",
  "config.skills.lookup",
  "config.skills.remove",
  "config.skills.setUsedBy",
  "config.skills.update",
  "control.purge",
  "control.status",
  "control.stop",
  "control.toolCheck",
  "conversations.list",
  "conversations.markRead",
  "conversations.messages",
  "events.subscribe",
  "memory.delete",
  "memory.edit",
  "memory.journal",
  "memory.list",
  "memory.rules.get",
  "memory.rules.save",
  "memory.save",
  "ops.sessions",
  "ops.spend",
  "ops.wakes",
  "questions.answer",
  "questions.pending",
  "schedules.create",
  "schedules.delete",
  "schedules.get",
  "schedules.list",
  "schedules.runNow",
  "schedules.runs",
  "schedules.setEnabled",
  "schedules.update",
  "tickets.comment",
  "tickets.create",
  "tickets.get",
  "tickets.list",
  "tickets.update",
];

type Proc = any;

/** The procedure at a dot path. */
function procAt(path: string): Proc {
  return path.split(".").reduce((node: any, key) => node[key], contract);
}

/** The input schema of a procedure. */
const inputOf = (path: string) => procAt(path)["~orpc"].inputSchema;

const uuid = "123e4567-e89b-42d3-a456-426614174000";

test("the contract has exactly the shared-contract procedures", () => {
  expect(ALL).toHaveLength(75);
  expect(listProcedurePaths(contract)).toEqual(ALL);
});

test("every procedure declares the six typed errors", () => {
  for (const p of ALL) {
    expect(Object.keys(procAt(p)["~orpc"].errorMap).sort()).toEqual([
      "BAD_REQUEST",
      "CONFLICT",
      "NOT_FOUND",
      "NOT_IMPLEMENTED",
      "PAYLOAD_TOO_LARGE",
      "UNAUTHORIZED",
    ]);
  }
});

test("refusals at the edge", () => {
  const six = Array.from({ length: 6 }, () => uuid);
  const fiftyOne = Array.from({ length: 51 }, () => ({ text: "r", on: true }));
  expect(
    inputOf("chat.send").safeParse({ conversationId: "bot:a", text: "x", uploadIds: six }).success,
  ).toBe(false);
  expect(
    inputOf("config.bots.setAvatar").safeParse({ id: "a", preset: "p", uploadId: uuid }).success,
  ).toBe(false);
  expect(inputOf("config.bots.setAvatar").safeParse({ id: "a" }).success).toBe(false);
  expect(
    inputOf("config.groups.setAvatar").safeParse({ id: "a", none: true, preset: "p" }).success,
  ).toBe(false);
  expect(inputOf("config.skills.lookup").safeParse({ source: "git@host:x" }).success).toBe(false);
  expect(inputOf("config.skills.lookup").safeParse({ source: "http://h/x" }).success).toBe(false);
  expect(
    inputOf("config.owner.save").safeParse({ file: "USER", text: "x".repeat(20_001) }).success,
  ).toBe(false);
  expect(inputOf("memory.rules.save").safeParse({ owner: "bot:a", rules: fiftyOne }).success).toBe(
    false,
  );
  expect(inputOf("conversations.messages").safeParse({ id: "bot:a", limit: 101 }).success).toBe(
    false,
  );
  expect(inputOf("tickets.create").safeParse({ title: "" }).success).toBe(false);
});

test("happy paths at the edge", () => {
  expect(inputOf("conversations.messages").parse({ id: "bot:a" }).limit).toBe(50);
  expect(inputOf("config.bots.setAvatar").safeParse({ id: "a", preset: "p" }).success).toBe(true);
  expect(inputOf("config.groups.setAvatar").safeParse({ id: "a", none: true }).success).toBe(true);
  expect(
    inputOf("config.skills.lookup").safeParse({ source: "https://github.com/o/r" }).success,
  ).toBe(true);
});

test("avatar create: oversize passes validation (handler answers 413), png is refused", () => {
  const ok = { kind: "bot", id: "a", size: MAX_AVATAR_BYTES + 1, type: "image/webp" };
  expect(inputOf("config.avatars.create").safeParse(ok).success).toBe(true);
  expect(inputOf("config.avatars.create").safeParse({ ...ok, type: "image/png" }).success).toBe(
    false,
  );
});

test("skill and MCP server names use the config name rules", () => {
  const bad = ["../x", "a/b", ""];
  for (const path of ["config.skills.install", "config.skills.update"]) {
    for (const name of bad)
      expect(inputOf(path).safeParse({ lookupId: "l", name }).success).toBe(false);
    expect(inputOf(path).safeParse({ lookupId: "l", name: "my-skill.v2" }).success).toBe(true);
  }
  for (const path of ["config.skills.checkUpdate", "config.skills.remove"]) {
    for (const name of bad) expect(inputOf(path).safeParse({ name }).success).toBe(false);
    expect(inputOf(path).safeParse({ name: "my-skill" }).success).toBe(true);
  }
  for (const name of bad)
    expect(inputOf("config.skills.setUsedBy").safeParse({ name, botIds: [] }).success).toBe(false);
  for (const path of ["config.mcp.delete"]) {
    for (const name of bad) expect(inputOf(path).safeParse({ name }).success).toBe(false);
    expect(inputOf(path).safeParse({ name: "firecrawl" }).success).toBe(true);
  }
  for (const server of bad)
    expect(inputOf("config.mcp.calls").safeParse({ server, limit: 5 }).success).toBe(false);
  expect(inputOf("config.mcp.calls").safeParse({ server: "firecrawl", limit: 5 }).success).toBe(
    true,
  );
  const spec = { type: "http", url: "https://x.example.com" };
  for (const path of ["config.mcp.save", "config.mcp.test"])
    for (const name of bad)
      expect(inputOf(path).safeParse({ name, server: spec, mode: "create" }).success).toBe(false);
});

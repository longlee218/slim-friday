import { expect, test } from "bun:test";
import type { ThreadTitlePort } from "../src/ingress/thread-rename";
import { buildServers } from "../src/mcp/mcp-servers";
import { ORCHESTRATION_MCP_SERVER } from "../src/mcp/mcp-tool-names";
import {
  DIGEST_MAX_CHARS,
  ORCHESTRATE_TOOL,
  SET_TITLE_MAX_CALLS_PER_RUN,
  TITLE_MAX_CHARS,
} from "../src/mcp/orchestration/tools/OrchestrateTool/constants";
import { createOrchestrateTool } from "../src/mcp/orchestration/tools/OrchestrateTool/orchestrate-tool";
import { localDay } from "../src/memory/memory-clock";
import type { MemoryToolContext } from "../src/memory/memory-tool-context";
import { getRole } from "../src/roles/role-registry";
import { openDb } from "../src/storage/db";
import { adoptThread, getThread, recordBotThread } from "../src/storage/thread-store";
import { toolsByServer } from "./mcp-ctx-fixture";

const PH = "⏳ 10-14 08:58";
const CREATED = new Date(2026, 9, 14, 8, 58).getTime();

/** Fake port: renames only when the placeholder equals the live name (like the real one); records calls. */
function setup(live: string = PH) {
  const calls: string[][] = [];
  const port: ThreadTitlePort = {
    rename: async (id, placeholder, name) => {
      calls.push([id, placeholder, name]);
      return placeholder === live ? "renamed" : "kept";
    },
  };
  const db = openDb(":memory:");
  const ctx = {
    db,
    home: "/tmp/none",
    workspace: "main",
    locationNames: () => [],
    threadLabel: "t",
    threadId: "t1",
    threadTitle: port,
  } as MemoryToolContext;
  // Only `set_title` is called, so the lead ctx is never read.
  const tool = createOrchestrateTool({ lead: {} as never, memory: ctx, titleCalls: { n: 0 } });
  const call = async (title: string, digest: string) => {
    const r = await tool.handler({ action: "set_title", params: { title, digest } } as never, {});
    const reply = JSON.parse((r.content[0] as { text: string }).text);
    return { text: (reply.note ?? reply.message) as string, isError: !!r.isError };
  };
  return { db, calls, call, ctx };
}

test("placeholder equals live name: renamed with MM-DD from the row, title+digest stored", async () => {
  const s = setup();
  recordBotThread(s.db, "t1", "c1", "main", PH, CREATED);
  const r = await s.call("Fix login bug", "Owner asks about the login bug.");
  expect(r.text).toBe("saved; thread renamed");
  expect(s.calls).toEqual([["t1", PH, "10-14 Fix login bug"]]);
  expect(getThread(s.db, "t1")).toMatchObject({
    title: "Fix login bug",
    digest: "Owner asks about the login bug.",
  });
});

test("owner renamed the thread: kept, but title and digest are stored (overwrite)", async () => {
  const s = setup("my own name");
  recordBotThread(s.db, "t1", "c1", "main", PH, CREATED);
  expect((await s.call("A", "one")).text).toBe("saved; thread name kept");
  await s.call("B", "two");
  expect(getThread(s.db, "t1")).toMatchObject({ title: "B", digest: "two" });
});

test("adopted thread (no placeholder): never calls the port", async () => {
  const s = setup();
  adoptThread(s.db, "t1", "c1", "main");
  expect((await s.call("T", "d")).text).toBe("saved; thread name kept");
  expect(s.calls).toEqual([]);
  expect(getThread(s.db, "t1")?.title).toBe("T");
});

test("secrets are redacted, lines collapsed, lengths clipped", async () => {
  const s = setup();
  recordBotThread(s.db, "t1", "c1", "main", PH, CREATED);
  const token = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
  await s.call(`deploy ${token}\n\nnow`, `line one ${token}\nline two ${"x".repeat(400)}`);
  const row = getThread(s.db, "t1")!;
  expect(row.title).not.toContain(token);
  expect(row.digest).not.toContain(token);
  expect(row.title).not.toMatch(/\n/);
  expect(row.digest).not.toMatch(/\n/);
  expect(row.title!.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  expect(row.digest!.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
  expect(s.calls[0]![2]).not.toContain(token);
  expect(s.calls[0]![2].length).toBeLessThanOrEqual(100);
});

test("date falls back to today when the row is new; empty text refused", async () => {
  const s = setup();
  await s.call("Topic", "d");
  expect(s.calls).toEqual([]); // unknown thread has no placeholder: kept
  expect((await s.call("   ", "d")).isError).toBe(true);
  expect(localDay(new Date()).length).toBe(10);
});

test("call cap: the call after the limit is refused and stores nothing", async () => {
  const s = setup();
  recordBotThread(s.db, "t1", "c1", "main", PH, CREATED);
  for (let i = 0; i < SET_TITLE_MAX_CALLS_PER_RUN; i++) await s.call(`T${i}`, "d");
  const r = await s.call("late", "d");
  expect(r.isError).toBe(true);
  expect(getThread(s.db, "t1")?.title).toBe(`T${SET_TITLE_MAX_CALLS_PER_RUN - 1}`);
});

test("offered as an Orchestrate action only with ctx.threadTitle; a developer never gets the tool", () => {
  const s = setup();
  const names = (role: string, c: MemoryToolContext) =>
    toolsByServer(buildServers(getRole(role), { memory: c, lead: {} as never }))[
      ORCHESTRATION_MCP_SERVER
    ] ?? [];
  expect(names("lead", s.ctx)).toContain(ORCHESTRATE_TOOL);
  expect(names("developer", s.ctx)).not.toContain(ORCHESTRATE_TOOL);
  const listed = (c: MemoryToolContext) =>
    createOrchestrateTool({ lead: {} as never, memory: c, titleCalls: { n: 0 } }).description;
  expect(listed(s.ctx)).toContain("set_title");
  expect(listed({ ...s.ctx, threadTitle: undefined })).not.toContain("set_title");
});

test("clean strips bidi/zero-width chars and clips by code point (no split surrogate)", async () => {
  const s = setup();
  recordBotThread(s.db, "t1", "c1", "main", PH, CREATED);
  const title = `a‮b​c${"😀".repeat(TITLE_MAX_CHARS + 5)}`;
  await s.call(title, "dig⁦est");
  const row = getThread(s.db, "t1");
  expect(row?.digest).toBe("digest");
  expect(row?.title?.startsWith("abc😀")).toBe(true);
  expect(Array.from(row!.title!).length).toBe(TITLE_MAX_CHARS);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(row!.title!)).toBe(false);
});

test("unknown thread row is created with the run's channel id and workspace", async () => {
  const s = setup();
  s.ctx.channelId = "chanX";
  await s.call("Title", "Digest");
  expect(getThread(s.db, "t1")).toMatchObject({ channel_id: "chanX", workspace: "main" });
});

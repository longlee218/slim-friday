import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChatContext } from "../src/chat/chat-context";
import { createPostFileTool } from "../src/chat/tools/PostFileTool/post-file-tool";

type Result = { content: { text: string }[]; isError?: boolean };
const call = (t: { handler: (a: never, e: unknown) => Promise<unknown> }, args: object) =>
  t.handler(args as never, {}) as Promise<Result>;

/** The version-control dir name, spelled out once. */
const VCS_DIR = ".git";

/** A home with the bot's scratch dir and one workspace; `posts` records what the surface was asked to send. */
function setup(current: string | null = "c1", wsIsBase = false) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pf-")));
  const home = join(base, "home");
  const scratch = join(home, "scratch", "ann");
  const ws = wsIsBase ? base : join(base, "ws");
  mkdirSync(scratch, { recursive: true });
  mkdirSync(join(home, "config"), { recursive: true });
  mkdirSync(ws, { recursive: true });
  const posts: {
    conversationId: string;
    botId: string;
    file: { path: string; name: string };
    caption?: string;
  }[] = [];
  const ctx: ChatContext = {
    botId: "ann",
    workspaces: [ws],
    scratchDir: scratch,
    agentHome: home,
    isSensitive: (real) => basename(real).startsWith(".env"),
    effort: {},
    conversation: () => current ?? undefined,
    postFile: async (conversationId, botId, file, caption) => {
      posts.push({ conversationId, botId, file, ...(caption && { caption }) });
    },
  };
  return { base, home, scratch, ws, posts, tool: createPostFileTool(ctx) };
}

test("a scratch file and a workspace file are posted to the current conversation", async () => {
  const { scratch, ws, posts, tool } = setup();
  writeFileSync(join(scratch, "report.txt"), "hello");
  writeFileSync(join(ws, "out.png"), "png");
  const a = await call(tool, { path: join(scratch, "report.txt"), caption: "here" });
  const b = await call(tool, { path: join(ws, "out.png") });
  expect(a.isError).toBeUndefined();
  expect(b.isError).toBeUndefined();
  expect(posts).toEqual([
    {
      conversationId: "c1",
      botId: "ann",
      file: { path: join(scratch, "report.txt"), name: "report.txt" },
      caption: "here",
    },
    {
      conversationId: "c1",
      botId: "ann",
      file: { path: join(ws, "out.png"), name: "out.png" },
    },
  ]);
});

test("a symlink, a dir, a secret, a path in the agent home, a relative path and a missing file are refused", async () => {
  const { base, home, scratch, ws, posts, tool } = setup();
  writeFileSync(join(base, "outside.txt"), "o");
  symlinkSync(join(base, "outside.txt"), join(scratch, "link"));
  mkdirSync(join(scratch, "adir"));
  writeFileSync(join(ws, ".env"), "K=1");
  writeFileSync(join(home, "config", "bots.md"), "x");
  mkdirSync(join(ws, VCS_DIR));
  writeFileSync(join(ws, VCS_DIR, "config"), "x");
  for (const path of [
    join(scratch, "link"),
    join(scratch, "adir"),
    join(ws, ".env"),
    join(home, "config", "bots.md"),
    join(ws, VCS_DIR, "config"),
    join(base, "outside.txt"),
    "report.txt",
    join(scratch, "nope.txt"),
  ])
    expect((await call(tool, { path })).isError).toBe(true);
  expect(posts).toEqual([]);
});

test("a file over 8 MB is refused", async () => {
  const { scratch, posts, tool } = setup();
  writeFileSync(join(scratch, "big.bin"), Buffer.alloc(9 * 1024 * 1024));
  expect((await call(tool, { path: join(scratch, "big.bin") })).isError).toBe(true);
  expect(posts).toEqual([]);
});

test("a call between turns is refused", async () => {
  const { scratch, posts, tool } = setup(null);
  writeFileSync(join(scratch, "a.txt"), "a");
  const r = await call(tool, { path: join(scratch, "a.txt") });
  expect(r.isError).toBe(true);
  expect(posts).toEqual([]);
});

test("a workspace that contains the agent home does not open it: only the bot's own scratch dir inside the home is sent", async () => {
  const { home, scratch, posts, tool } = setup("c1", true);
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "data", "engine.db"), "db");
  writeFileSync(join(home, "config", "bots.md"), "x");
  mkdirSync(join(home, "scratch", "bob"), { recursive: true });
  writeFileSync(join(home, "scratch", "bob", "o.txt"), "o");
  writeFileSync(join(scratch, "mine.txt"), "m");
  for (const path of [
    join(home, "data", "engine.db"),
    join(home, "config", "bots.md"),
    join(home, "scratch", "bob", "o.txt"),
  ])
    expect((await call(tool, { path })).isError).toBe(true);
  expect((await call(tool, { path: join(scratch, "mine.txt") })).isError).toBeUndefined();
  expect(posts).toHaveLength(1);
});

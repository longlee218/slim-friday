import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment, Bot, BotRuntimeSpec } from "@friday/core";
import { ClaudeRuntime } from "../src/claude-runtime";
import { fakeQuery } from "./fake-query";

const root = realpathSync(mkdtempSync(join(tmpdir(), "att-")));
const bot: Bot = {
  id: "b1",
  name: "Ann",
  title: "",
  instructions: "",
  model: "sonnet",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
};
const spec: BotRuntimeSpec = {
  bot,
  runKind: "owner",
  decide: async () => ({ behavior: "allow" }),
};

/** A saved file of `size` bytes, as the surface leaves it. */
function saved(name: string, mimeType: string, size: number): Attachment {
  const path = join(root, name);
  writeFileSync(path, Buffer.alloc(size, 1));
  return { name, mimeType, path, size };
}
type Block = { type: string; text?: string; source?: { media_type: string; data: string } };

/** Send one turn with `files` and return the content blocks the SDK received. */
async function sendWith(files: Attachment[]): Promise<{ blocks: Block[]; scratch: string }> {
  const fq = fakeQuery();
  const scratchRoot = join(root, `runs-${Math.random()}`);
  const rt = new ClaudeRuntime({
    agentHome: join(root, "home"),
    scratchRoot,
    queryFn: fq.queryFn,
    sessionExists: async () => true,
  });
  const s = await rt.open(spec);
  s.send({
    conversationId: "c1",
    from: { kind: "user" },
    text: "look",
    hop: 0,
    context: [],
    now: 0,
    timeZone: "UTC",
    attachments: files,
  });
  await Bun.sleep(20);
  return { blocks: fq.sentContent()[0] as Block[], scratch: join(scratchRoot, "b1") };
}

test("an image arrives as an image block with its media type", async () => {
  const { blocks } = await sendWith([saved("1-a.png", "image/png", 10)]);
  const img = blocks.find((b) => b.type === "image");
  expect(img?.source?.media_type).toBe("image/png");
  expect(img?.source?.data).toBe(Buffer.alloc(10, 1).toString("base64"));
  expect(blocks.find((b) => b.type === "text")?.text).toContain("Attached files:");
});

test("a pdf is copied into the scratch inbox and its path is in the text", async () => {
  const { blocks, scratch } = await sendWith([saved("1-doc.pdf", "application/pdf", 20)]);
  expect(blocks.some((b) => b.type === "image")).toBe(false);
  const text = blocks.find((b) => b.type === "text")?.text ?? "";
  const path = text.match(new RegExp(`${scratch}/inbox/\\S+1-doc\\.pdf`))?.[0];
  expect(path).toBeDefined();
  expect(existsSync(path as string)).toBe(true);
  expect(readFileSync(path as string).length).toBe(20);
});

test("a 6 MB image goes the file way", async () => {
  const { blocks, scratch } = await sendWith([saved("1-big.png", "image/png", 6 * 1024 * 1024)]);
  expect(blocks.some((b) => b.type === "image")).toBe(false);
  expect(blocks.find((b) => b.type === "text")?.text).toContain(`${scratch}/inbox/`);
});

test("a turn without files stays a plain string", async () => {
  const fq = fakeQuery();
  const rt = new ClaudeRuntime({
    agentHome: join(root, "home"),
    scratchRoot: join(root, "runs-plain"),
    queryFn: fq.queryFn,
    sessionExists: async () => true,
  });
  const s = await rt.open(spec);
  s.send({
    conversationId: "c1",
    from: { kind: "user" },
    text: "hi",
    hop: 0,
    context: [],
    now: 0,
    timeZone: "UTC",
  });
  await Bun.sleep(20);
  expect(typeof fq.sentContent()[0]).toBe("string");
});

test("steer pushes the framed text and files into the input queue, nothing after stop", async () => {
  const fq = fakeQuery();
  const rt = new ClaudeRuntime({
    agentHome: join(root, "home"),
    scratchRoot: join(root, "runs-steer"),
    queryFn: fq.queryFn,
    sessionExists: async () => true,
  });
  const s = await rt.open(spec);
  s.steer({ text: "New message from the owner while you work:\nstop that" });
  s.steer({ text: "look", attachments: [saved("1-s.png", "image/png", 10)] });
  await Bun.sleep(20);
  const [plain, withImage] = fq.sentContent() as [string, Block[]];
  expect(plain).toBe("New message from the owner while you work:\nstop that");
  expect(withImage.some((b) => b.type === "image")).toBe(true);
  await s.stop();
  s.steer({ text: "late" });
  await Bun.sleep(20);
  expect(fq.sentContent()).toHaveLength(2);
});

test("a file that is gone becomes a note line in a steer push and in a turn", async () => {
  const fq = fakeQuery();
  const rt = new ClaudeRuntime({
    agentHome: join(root, "home"),
    scratchRoot: join(root, "runs-gone"),
    queryFn: fq.queryFn,
    sessionExists: async () => true,
  });
  const s = await rt.open(spec);
  const gone: Attachment[] = [
    { name: "x.png", mimeType: "image/png", path: join(root, "nope.png"), size: 5 },
    { name: "y.pdf", mimeType: "application/pdf", path: join(root, "nope.pdf"), size: 5 },
  ];
  s.steer({ text: "look", attachments: gone });
  s.send({
    conversationId: "c1",
    from: { kind: "user" },
    text: "hi",
    hop: 0,
    context: [],
    now: 0,
    timeZone: "UTC",
    attachments: gone,
  });
  await Bun.sleep(20);
  for (const blocks of fq.sentContent() as Block[][]) {
    const text = blocks.find((b) => b.type === "text")?.text ?? "";
    expect(text).toContain("[file no longer available: x.png]");
    expect(text).toContain("[file no longer available: y.pdf]");
  }
  expect(fq.sentContent()).toHaveLength(2);
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { InboundMessage } from "@friday/core";
import { DiscordSurface } from "../src/discord-surface";
import { downloadAttachments } from "../src/download-attachments";
import { FakeDiscordPort } from "./fake-discord-port";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "attach-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fetch that answers every url with `size` bytes. */
const fetchOf =
  (size: number) =>
  async (_url: string | URL | Request): Promise<Response> =>
    new Response(new Uint8Array(size).fill(7), { headers: { "content-length": String(size) } });
const item = (name: string, size = 3) => ({ url: `https://cdn/x/${name}`, name, size });

test("hostile names land inside the dir with safe names", async () => {
  const long = `${"a".repeat(300)}.txt`;
  const r = await downloadAttachments(
    [item("../x"), item("a/b"), item(long), item(".env"), item("..\\..\\evil.sh")],
    dir,
    fetchOf(3),
  );
  expect(r.refused).toEqual([]);
  expect(r.saved).toHaveLength(5);
  const root = resolve(dir) + sep;
  for (const a of r.saved) {
    expect(resolve(a.path).startsWith(root)).toBe(true);
    expect(a.name).toMatch(/^\d-[A-Za-z0-9._-]{1,100}$/);
    expect(existsSync(a.path)).toBe(true);
  }
  expect(readdirSync(dir)).toHaveLength(5);
});

test("a 21 MB file and a 6th file are refused and named", async () => {
  const big = await downloadAttachments([item("big.bin", 21 * 1024 * 1024)], dir, fetchOf(1));
  expect(big.saved).toEqual([]);
  expect(big.refused[0]).toContain("big.bin");
  const many = await downloadAttachments(
    ["a", "b", "c", "d", "e", "f"].map((n) => item(n)),
    dir,
    fetchOf(3),
  );
  expect(many.saved).toHaveLength(5);
  expect(many.refused[0]).toContain("f");
});

test("a body larger than it claimed is refused and not kept", async () => {
  const lie = async () => new Response(new Uint8Array(21 * 1024 * 1024));
  const r = await downloadAttachments([item("liar.bin", 3)], dir, lie);
  expect(r.saved).toEqual([]);
  expect(r.refused).toHaveLength(1);
  expect(readdirSync(dir)).toEqual([]);
});

test("a failed download is refused; the content of a good one is kept", async () => {
  const bad = await downloadAttachments(
    [item("a.txt")],
    dir,
    async () => new Response("no", { status: 404 }),
  );
  expect(bad.refused[0]).toContain("a.txt");
  const ok = await downloadAttachments(
    [{ ...item("n.txt", 4), contentType: "text/plain" }],
    dir,
    fetchOf(4),
  );
  expect(ok.saved[0]?.mimeType).toBe("text/plain");
  expect(readFileSync(ok.saved[0]?.path as string).length).toBe(4);
});

function setup() {
  const port = new FakeDiscordPort();
  const surface = new DiscordSurface(port, () => "Ann", {
    inboxDir: dir,
    now: () => 1000,
    fetchFn: fetchOf(3),
  });
  surface.mapChannel("ch1", { kind: "bot", botId: "ann" });
  const got: InboundMessage[] = [];
  surface.onMessage((m) => got.push(m));
  return { port, got };
}

test("the owner's files are saved under inbox/<channel>/ and delivered; a message with only files counts", async () => {
  const { port, got } = setup();
  port.emitMessage({ channelId: "ch1", text: "", attachments: [item("pic.png")] });
  await Bun.sleep(50);
  expect(got).toHaveLength(1);
  const a = got[0]?.attachments?.[0];
  expect(resolve(a?.path as string).startsWith(resolve(join(dir, "ch1")) + sep)).toBe(true);
  expect(got[0]?.text.length).toBeGreaterThan(0);
});

test("a non-owner's or a webhook's message with files is ignored and nothing is downloaded", async () => {
  const { port, got } = setup();
  port.emitMessage({
    channelId: "ch1",
    text: "x",
    authorId: "stranger",
    attachments: [item("a.png")],
  });
  port.emitMessage({
    channelId: "ch1",
    text: "x",
    fromBotOrWebhook: true,
    attachments: [item("a.png")],
  });
  await Bun.sleep(50);
  expect(got).toEqual([]);
  expect(existsSync(join(dir, "ch1"))).toBe(false);
});

test("a refused file is reported in the channel and the rest still goes through", async () => {
  const { port, got } = setup();
  port.emitMessage({
    channelId: "ch1",
    text: "hi",
    attachments: [item("huge.bin", 21 * 1024 * 1024), item("ok.txt")],
  });
  await Bun.sleep(50);
  expect(got[0]?.attachments).toHaveLength(1);
  expect(port.sent.some((s) => s.text.includes("huge.bin"))).toBe(true);
});

test("postFile sends the file through the port under the bot's name", async () => {
  const port = new FakeDiscordPort();
  const surface = new DiscordSurface(port, () => "Ann");
  await surface.postFile(
    "ch1",
    { kind: "bot", botId: "ann" },
    { path: "/x/a.txt", name: "a.txt" },
    "cap",
  );
  expect(port.filesSent).toEqual([
    {
      channelId: "ch1",
      username: "Ann",
      file: { path: "/x/a.txt", name: "a.txt" },
      caption: "cap",
    },
  ]);
});

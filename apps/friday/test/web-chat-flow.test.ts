import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { botFile, until, webHarness } from "./web-harness";

const MB = 1024 * 1024;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});
async function boot(files: Record<string, string> = {}) {
  const h = await webHarness(files);
  stops.push(h.stop);
  return h;
}

test.todo("send -> bot reply event with run steps (restored in Task 8)", async () => {
  const h = await boot();
  h.runtime.onTurn = (s) => {
    s.emit({ type: "thinking" });
    s.emit({ type: "tool_call", toolUseId: "t1", tool: "Read", input: { file_path: "/x" } });
    s.emit({ type: "tool_result", toolUseId: "t1", ok: true });
    s.emit({ type: "text", text: "done" });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  await h.client.chat.send({ conversationId: "bot:friday", text: "hi" });
  await until(() => h.of("message").some((m) => m.message.author.kind === "bot"));
  expect(h.of("run").length).toBe(4);
  const reply = h.of("message").find((m) => m.message.author.kind === "bot");
  expect(reply?.message.text).toBe("done");
  expect(reply?.message.run?.length).toBe(2);
  // 2 = the unread boot greeting plus this reply.
  await until(() => h.of("unread").some((u) => u.unread === 2));
  const page = await h.client.conversations.messages({ id: "bot:friday", limit: 10 });
  expect(page.map((m) => m.text)).toContain("hi");
  expect(page.map((m) => m.text)).toContain("done");
});

test.todo("an approval answered through the API lets the tool run (restored in Task 8)", async () => {
  const h = await boot();
  await h.client.chat.send({ conversationId: "bot:friday", text: "hi" });
  await until(() => h.runtime.opened.length === 1);
  const decided = h.runtime.nth(0).spec.decide({ tool: "Bash", input: { command: "ls" } });
  await until(() => h.of("approval.opened").length === 1);
  const card = h.of("approval.opened")[0];
  const cardId = (card as unknown as { card: { cardId: string } }).card.cardId;
  await h.client.approvals.answer({ cardId, answer: "once" });
  expect(await decided).toEqual({ behavior: "allow" });
  await until(() => h.of("approval.closed").length === 1);
  await expect(h.client.approvals.answer({ cardId, answer: "deny" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  expect(h.of("approval.closed").length).toBe(1);
});

test.todo("a question answered through the API reaches the bot (restored in Task 8)", async () => {
  const h = await boot();
  await h.client.chat.send({ conversationId: "bot:friday", text: "hi" });
  await until(() => h.runtime.opened.length === 1);
  const asked = h.runtime.nth(0).spec.ask?.({
    botId: "friday",
    botName: "Friday",
    question: "Which?",
    kind: "single",
    options: [{ value: "x", label: "X" }],
    allowText: false,
  });
  await until(() => h.of("question.opened").length === 1);
  const cardId = (await h.client.questions.pending())[0]?.cardId ?? "";
  await h.client.questions.answer({ cardId, choices: ["x"] });
  expect(await asked).toEqual({ choices: ["x"] });
  await until(() => h.of("question.closed").length === 1);
});

test.todo("a reply in a group goes to the replied-to bot (restored in Task 8)", async () => {
  const h = await boot({
    "bots/dev.md": botFile("Dev"),
    "bots/tess.md": botFile("Tess"),
    "groups/team.yaml": "name: Team\nmembers: [dev, tess]\nentryBot: dev\n",
  });
  // Tess answers, so the end of her turn shows the whole routing has happened.
  h.runtime.onTurn = (s) => {
    s.emit({ type: "text", text: "tess replies" });
    s.emit({ type: "turn_end", costUsd: 0 });
  };
  const tessMsg = await h.engine.messages.append({
    conversationId: "group:team",
    author: { kind: "bot", botId: "tess" },
    text: "tess says",
    at: Date.now(),
  });
  await h.client.chat.send({ conversationId: "group:team", text: "and?", replyTo: tessMsg });
  await until(() => h.runtime.opened.length >= 1 && h.runtime.nth(0).sent.length === 1);
  await until(() => h.of("message").some((m) => m.message.text === "tess replies"));
  expect(h.runtime.opened.map((s) => s.spec.bot.id)).toEqual(["tess"]);
  expect(h.runtime.nth(0).sent[0]?.quote?.text).toBe("tess says");
});

test.todo("an upload is accepted and an oversized one refused (restored in Task 8)", async () => {
  const h = await boot();
  const mk = (name: string, size: number) =>
    h.client.chat.uploadCreate({
      conversationId: "bot:friday",
      name,
      type: "text/plain",
      size,
    });
  const ok = await mk("a.txt", 5);
  await h.files.put(`uploads/bot:friday/${ok.uploadId}/a.txt`, "hello", "text/plain");
  await h.client.chat.send({ conversationId: "bot:friday", text: "see", uploadIds: [ok.uploadId] });
  await until(() => h.runtime.opened.length === 1 && h.runtime.nth(0).sent.length === 1);
  const att = h.runtime.nth(0).sent[0]?.attachments ?? [];
  expect(att.map((a) => a.size)).toEqual([5]);

  const big = await mk("b.bin", 10);
  await h.files.put(
    `uploads/bot:friday/${big.uploadId}/b.bin`,
    new Uint8Array(20 * MB + 1),
    "application/octet-stream",
  );
  await expect(
    h.client.chat.send({ conversationId: "bot:friday", text: "x", uploadIds: [big.uploadId] }),
  ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  expect(h.files.deleted.some((k) => k.includes(big.uploadId))).toBe(true);
});

test("PostFile from the bot shows as an image message", async () => {
  // Called on the surface as the PostFile tool does (the tool itself needs the SDK's tool() wrapper).
  const h = await boot();
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const path = join(h.home, "pic.png");
  writeFileSync(path, png);
  await h.surface.postFile(
    "bot:friday",
    { kind: "bot", botId: "friday" },
    { path, name: "pic.png" },
    "look",
  );
  await until(() => h.of("message").some((m) => m.message.kind === "file"));
  const m = h.of("message").find((e) => e.message.kind === "file")?.message;
  expect(m?.text).toBe("look");
  expect(m?.files?.[0]).toMatchObject({
    name: "pic.png",
    mimeType: "image/png",
    width: 1,
    height: 1,
  });
  const { url } = await h.client.chat.file({ id: m?.files?.[0]?.id ?? "" });
  expect(url).not.toContain("dl=");
});

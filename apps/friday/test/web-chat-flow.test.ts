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

test("send -> bot reply event with run steps", async () => {
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

// CreateProject is a write: it asks at balanced (Bash is local and runs unasked).
test("an approval parks the run; the answer through the API resumes it with the exact call allowed once", async () => {
  const h = await boot();
  await h.client.chat.send({ conversationId: "bot:friday", text: "hi" });
  await until(() => h.runtime.opened.length === 1);
  const decided = await h.runtime
    .nth(0)
    .spec.decide({ tool: "mcp__effects__CreateProject", input: { name: "ls" } });
  expect(decided.behavior).toBe("park");
  await until(() => h.of("approval.opened").length === 1);
  const cardId = (await h.client.approvals.pending())[0]?.cardId ?? "";
  await h.client.approvals.answer({ cardId, answer: "once" });
  await until(() => h.of("approval.closed").length === 1);
  await expect(h.client.approvals.answer({ cardId, answer: "deny" })).rejects.toMatchObject({
    code: "CONFLICT",
  });
  // The parked run resumes in its own session with the approval continuation.
  await until(
    () => h.runtime.resumed.length === 1 && h.runtime.resumed[0]?.session.sent.length === 1,
  );
  const resumed = h.runtime.resumed[0]?.session;
  expect(resumed?.sent[0]?.text).toContain(
    'The owner approved: mcp__effects__CreateProject {"name":"ls"}.',
  );
  expect(
    await resumed?.spec.decide({ tool: "mcp__effects__CreateProject", input: { name: "ls" } }),
  ).toEqual({
    behavior: "allow",
  });
  expect(h.of("approval.closed").length).toBe(1);
});

test("a question answered through the API reaches the bot on resume", async () => {
  const h = await boot();
  await h.client.chat.send({ conversationId: "bot:friday", text: "hi" });
  await until(() => h.runtime.opened.length === 1);
  const asked = await h.runtime.nth(0).spec.ask?.([
    {
      botId: "friday",
      botName: "Friday",
      question: "Which?",
      kind: "single",
      options: [{ value: "x", label: "X" }],
      allowText: false,
    },
  ]);
  expect(asked).toMatchObject({ behavior: "park" });
  await until(() => h.of("question.opened").length === 1);
  const cardId = (await h.client.questions.pending())[0]?.cardId ?? "";
  await h.client.questions.answer({ cardId, choices: ["x"] });
  await until(() => h.of("question.closed").length === 1);
  await until(() => h.runtime.resumed[0]?.session.sent.length === 1);
  expect(h.runtime.resumed[0]?.session.sent[0]?.text).toBe(
    'The owner answered your question "Which?": x',
  );
});

test("a reply in a group goes to the replied-to bot", async () => {
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

test("an upload is accepted and an oversized one refused", async () => {
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

test("an open card is listed again after a restart and its answer resumes the run", async () => {
  const first = await webHarness();
  await first.client.chat.send({ conversationId: "bot:friday", text: "hi" });
  await until(() => first.runtime.opened.length === 1);
  await first.runtime
    .nth(0)
    .spec.decide({ tool: "mcp__effects__CreateProject", input: { name: "ls" } });
  await until(() => first.of("approval.opened").length === 1);
  await first.stop();
  // A new boot over the same home: the stored card is shown again, nothing re-asks.
  const h = await webHarness({}, first.home);
  stops.push(h.stop);
  const pending = await h.client.approvals.pending();
  expect(pending.map((c) => c.tool)).toEqual(["mcp__effects__CreateProject"]);
  await h.client.approvals.answer({ cardId: pending[0]?.cardId ?? "", answer: "deny" });
  await until(() => h.runtime.created.length === 1 && h.runtime.created[0]?.sent.length === 1);
  expect(h.runtime.created[0]?.sent[0]?.text).toContain("The user denied this action.");
});

test("resend with the same clientNonce shows one message", async () => {
  const h = await boot();
  const input = { conversationId: "bot:friday", text: "once only", clientNonce: "n-1" };
  const first = await h.client.chat.send(input);
  const again = await h.client.chat.send(input);
  expect(again.messageId).toBe(first.messageId);
  const page = await h.client.conversations.messages({ id: "bot:friday", limit: 20 });
  expect(page.filter((m) => m.text === "once only")).toHaveLength(1);
});

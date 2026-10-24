import { expect, test } from "bun:test";
import type { FileRow, IndexedMessage } from "@friday/core";
import { toFileRef, toMessageDto } from "../src/message-dto";

const base: IndexedMessage = {
  id: 1,
  conversationId: "bot:a",
  author: { kind: "user" },
  text: "x",
  at: 1,
};

test("defaults: kind text, files empty, no replyTo", () => {
  const dto = toMessageDto(base);
  expect(dto).toMatchObject({ kind: "text", files: [] });
  expect(dto.replyTo).toBeUndefined();
});

test("files: id, image kind by mime, other files", () => {
  const dto = toMessageDto({
    ...base,
    kind: "file",
    files: [
      { fileId: "f1", name: "a.png", mimeType: "image/png", size: 5, width: 2, height: 3 },
      { fileId: "f2", name: "a.svg", mimeType: "image/svg+xml", size: 5 },
      { fileId: "f3", name: "a.pdf", mimeType: "application/pdf", size: 5 },
    ],
  });
  expect(dto.files.map((f) => [f.id, f.kind])).toEqual([
    ["f1", "image"],
    ["f2", "file"],
    ["f3", "file"],
  ]);
  expect(dto.files[0]).toMatchObject({ width: 2, height: 3, name: "a.png", size: 5 });
});

test("reply excerpt is one line, at most 140 code points", () => {
  const orig: IndexedMessage = {
    ...base,
    id: 7,
    author: { kind: "bot", botId: "pm" },
    text: "a\nb  ".repeat(200),
  };
  const reply = { ...base, id: 8, replyTo: 7 };
  const r = toMessageDto(reply, orig).replyTo;
  expect(r?.messageId).toBe(7);
  expect(r?.botId).toBe("pm");
  expect(r?.excerpt).not.toContain("\n");
  expect([...(r?.excerpt ?? "")].length).toBe(140);
  const emoji = toMessageDto(reply, { ...orig, text: "😀".repeat(200) }).replyTo?.excerpt;
  expect([...(emoji ?? "")].length).toBe(140);
  expect(toMessageDto(reply, { ...orig, author: { kind: "user" } }).replyTo?.botId).toBeUndefined();
});

test("run and relay pass through; toFileRef maps a row", () => {
  const run = [
    { id: "s", kind: "tool" as const, label: "Read", state: "done" as const, startedAt: 1 },
  ];
  const relay = { fromBotId: "a", toBotId: "b", intent: "request" as const };
  expect(toMessageDto({ ...base, run, relay })).toMatchObject({ run, relay });
  const row: FileRow = {
    id: "f1",
    key: "files/x",
    conversationId: "bot:a",
    name: "n.png",
    mimeType: "image/png",
    size: 9,
    width: 1,
    height: 2,
    source: "bot",
    at: 1,
  };
  expect(toFileRef(row)).toEqual({
    fileId: "f1",
    name: "n.png",
    mimeType: "image/png",
    size: 9,
    width: 1,
    height: 2,
  });
});

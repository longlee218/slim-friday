import { expect, test } from "bun:test";
import type { FileRow } from "@friday/core";
import { openEngineStore } from "../src/engine-store";

const row = (id: string, at: number, over: Partial<FileRow> = {}): FileRow => ({
  id,
  key: `files/bot:a/${id}/x`,
  conversationId: "bot:a",
  name: "x",
  mimeType: "image/png",
  size: 3,
  source: "upload",
  at,
  ...over,
});

async function seeded(rows: FileRow[]) {
  const s = openEngineStore(":memory:");
  for (const r of rows) await s.files.insert(r);
  return s;
}

test("listUploads: an empty store lists nothing", async () => {
  const s = await seeded([]);
  expect(await s.files.listUploads({ limit: 10 })).toEqual([]);
});

test("listUploads: bot-posted rows are never listed", async () => {
  const s = await seeded([row("b1", 5, { source: "bot" }), row("u1", 1)]);
  expect((await s.files.listUploads({ limit: 10 })).map((f) => f.id)).toEqual(["u1"]);
});

test("listUploads: newest first, id breaks a tie descending", async () => {
  const s = await seeded([row("a", 1), row("c", 3), row("b", 3)]);
  expect((await s.files.listUploads({ limit: 10 })).map((f) => f.id)).toEqual(["c", "b", "a"]);
});

test("listUploads: three rows with the same at, limit 2, come back once across two pages", async () => {
  const s = await seeded([row("a", 7), row("b", 7), row("c", 7)]);
  const p1 = await s.files.listUploads({ limit: 2 });
  const last = p1[p1.length - 1] as FileRow;
  const p2 = await s.files.listUploads({ limit: 2, cursor: { at: last.at, id: last.id } });
  expect([...p1, ...p2].map((f) => f.id)).toEqual(["c", "b", "a"]);
});

test("listUploads: kind pdf, image and other", async () => {
  const s = await seeded([
    row("p", 1, { mimeType: "application/pdf" }),
    row("j", 2, { mimeType: "image/jpeg" }),
    row("n", 3, { mimeType: "image/png" }),
    row("g", 4, { mimeType: "image/gif" }),
    row("w", 5, { mimeType: "image/webp" }),
    row("t", 6, { mimeType: "text/plain" }),
    row("s", 7, { mimeType: "image/svg+xml" }),
  ]);
  const ids = async (kind: "image" | "pdf" | "other") =>
    (await s.files.listUploads({ limit: 10, kind })).map((f) => f.id);
  expect(await ids("pdf")).toEqual(["p"]);
  expect(await ids("image")).toEqual(["w", "g", "n", "j"]);
  expect(await ids("other")).toEqual(["s", "t"]);
});

test("listUploads: conversationId filters, limit caps", async () => {
  const s = await seeded([row("a", 1), row("b", 2, { conversationId: "group:g" }), row("c", 3)]);
  expect(
    (await s.files.listUploads({ limit: 10, conversationId: "group:g" })).map((f) => f.id),
  ).toEqual(["b"]);
  expect(await s.files.listUploads({ limit: 1 })).toHaveLength(1);
});

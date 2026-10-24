import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryOwner, RecallNote, RecallSource } from "@friday/core";
import { MemoryError } from "../src/memory/file-memory";
import { WriteThroughMemory } from "../src/memory/write-through-memory";

const ann: MemoryOwner = { kind: "bot", botId: "ann" };

/** A source that records writes and forgets; `fail` makes both throw. */
function recorder(fail = false) {
  const log: string[] = [];
  const source: RecallSource = {
    id: "rec",
    search: async () => [],
    write: async (_o, n: RecallNote) => {
      if (fail) throw new Error("down");
      log.push(`write ${n.kind} ${n.text}`);
    },
    forget: async (_o, text) => {
      if (fail) throw new Error("down");
      log.push(`forget ${text}`);
    },
  };
  return { source, log };
}

function make(sources: RecallSource[]) {
  const root = mkdtempSync(join(tmpdir(), "wt-"));
  const warns: string[] = [];
  const mem = new WriteThroughMemory(root, sources, {
    log: { warn: (_o, m) => void warns.push(m) },
  });
  return { root, mem, warns };
}

test("a save reaches the file and every writable source", async () => {
  const a = recorder();
  const readOnly: RecallSource = { id: "ro", search: async () => [] };
  const { root, mem } = make([a.source, readOnly]);
  await mem.save(ann, "  deploy uses <b>docker</b> ", "decision");
  await mem.flush();
  expect(readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8")).toContain("deploy uses");
  expect(a.log).toHaveLength(1);
  expect(a.log[0]).toStartWith("write decision deploy uses");
  expect(a.log[0]).not.toContain("<b>");
});

test("a throwing source does not fail the save and is logged", async () => {
  const { root, mem, warns } = make([recorder(true).source]);
  await mem.save(ann, "still saved");
  await mem.flush();
  expect(readFileSync(join(root, "bots", "ann", "MEMORY.md"), "utf8")).toContain("still saved");
  expect(warns).toEqual(["memory.provider"]);
});

test("delete forgets the old text; replace forgets the old and writes the new with the same kind", async () => {
  const a = recorder();
  const { mem } = make([a.source]);
  await mem.save(ann, "uses npm", "preference");
  await mem.save(ann, "old fact");
  const [pref, fact] = mem.listBullets(ann);
  await mem.edit(ann, pref?.id ?? "", "uses bun");
  await mem.edit(ann, fact?.id ?? "", null);
  await mem.flush();
  expect(a.log.slice(2)).toEqual([
    "forget uses npm",
    "write preference uses bun",
    "forget old fact",
  ]);
});

test("a duplicate save writes nothing", async () => {
  const a = recorder();
  const { mem } = make([a.source]);
  await mem.save(ann, "uses bun");
  await expect(mem.save(ann, "uses bun")).rejects.toBeInstanceOf(MemoryError);
  await mem.flush();
  expect(a.log).toEqual(["write fact uses bun"]);
});

import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile } from "../src/memory/stamped-backup";

const dir = () => join(mkdtempSync(join(tmpdir(), "bk-")), "sub");

test("a backup keeps the bytes, is 0600 and the newest `keep` survive", () => {
  const d = dir();
  for (let i = 0; i < 25; i++)
    backupFile(d, "MEMORY.md", Buffer.from(`v${i}`), new Date(Date.UTC(2026, 9, 21, 12, 0, i)), 20);
  const names = readdirSync(d).sort();
  expect(names).toHaveLength(20);
  expect(readFileSync(join(d, names[19] as string), "utf8")).toBe("v24");
  expect(readFileSync(join(d, names[0] as string), "utf8")).toBe("v5");
  expect(statSync(join(d, names[0] as string)).mode & 0o777).toBe(0o600);
});

test("same millisecond never overwrites; other files in the dir are not pruned", () => {
  const d = dir();
  const t = new Date(Date.UTC(2026, 9, 21, 12));
  backupFile(d, "MEMORY.md", Buffer.from("a"), t, 1);
  writeFileSync(join(d, "notes.txt"), "keep me");
  const p2 = backupFile(d, "MEMORY.md", Buffer.from("b"), t, 5);
  expect(readFileSync(p2, "utf8")).toBe("b");
  expect(readdirSync(d).sort()).toHaveLength(3);
  backupFile(d, "MEMORY.md", Buffer.from("c"), new Date(t.getTime() + 1000), 1);
  expect(
    readdirSync(d)
      .sort()
      .filter((n) => n.startsWith("MEMORY.md")),
  ).toHaveLength(1);
  expect(readFileSync(join(d, "notes.txt"), "utf8")).toBe("keep me");
});

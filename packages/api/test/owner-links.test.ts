import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerLinkWriter } from "../src/auth/owner-links";

const tmp = () => mkdtempSync(join(tmpdir(), "owner-links-"));

test("a looser existing file ends 0600 after a write", () => {
  const f = join(tmp(), "owner-links.log");
  writeFileSync(f, "");
  chmodSync(f, 0o644);
  ownerLinkWriter(f, () => 0)("https://x.example.com/a");
  expect(statSync(f).mode & 0o777).toBe(0o600);
});

test("a missing logs dir is created 0700", () => {
  const dir = join(tmp(), "logs");
  ownerLinkWriter(join(dir, "owner-links.log"), () => 0)("https://x.example.com/a");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("two writes give two timestamped lines", () => {
  const f = join(tmp(), "logs", "owner-links.log");
  const write = ownerLinkWriter(f, () => 1_700_000_000_000);
  write("https://x.example.com/a");
  write("https://x.example.com/b");
  const lines = readFileSync(f, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  for (const l of lines) expect(l).toMatch(/^\d{4}-\d{2}-\d{2}T.+ https:\/\//);
});

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/* Every message the bot sends to Discord goes through src/providers/discord/ui/send/ (redaction, mention policy, one place
   to change when a message shape changes). No other file calls a send / reply / editReply / followUp method. */

/** Every .ts file under `dir`. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const SEND_DIR = join("src", "providers", "discord", "ui", "send") + "/";
const RAW_SEND = /\.(?:send|reply|editReply|followUp|deferReply|deleteReply)\s*\(/;
/** Inside the provider, editing or updating a message is also a send (`createHash().update(` elsewhere is not one). */
const RAW_EDIT = /\b(?:msg|message|interaction|cmd|i)\.(?:edit|update)\s*\(/;

test("no file outside ui/send calls a raw Discord send / reply / editReply / followUp", () => {
  const bad = tsFiles("src")
    .filter((f) => !f.startsWith(SEND_DIR))
    .filter((f) => RAW_SEND.test(readFileSync(f, "utf8")));
  expect(bad).toEqual([]);
});

test("inside src/providers, no file outside ui/send edits or updates a message directly", () => {
  const bad = tsFiles(join("src", "providers"))
    .filter((f) => !f.startsWith(SEND_DIR))
    .filter((f) => RAW_EDIT.test(readFileSync(f, "utf8")));
  expect(bad).toEqual([]);
});

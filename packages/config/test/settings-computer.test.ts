import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileConfig } from "../src/file-config";
import { DEFAULTS_DIR } from "../src/load-config";

test("the config carries the computer block of the last settings file that names it; none by default", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  const load = () => FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir }).config;
  expect(load().computer()).toBeUndefined();
  writeFileSync(
    join(userDir, "settings.yaml"),
    "computer:\n  provider: { id: cua, binary: /opt/cua }\n  slots: 1\n",
  );
  expect(load().computer()).toEqual({ provider: { id: "cua", binary: "/opt/cua" }, slots: 1 });
});

test("botList returns every loaded bot with its computer", () => {
  const userDir = mkdtempSync(join(tmpdir(), "cfg-"));
  const bots = join(userDir, "bots");
  mkdirSync(bots);
  writeFileSync(
    join(bots, "ann.md"),
    "---\nname: Ann\ntitle: t\nmodel: m\ncomputer: home\n---\nHi.\n",
  );
  const { config } = FileConfig.load({ defaultsDir: DEFAULTS_DIR, userDir });
  expect(config.botList().find((b) => b.id === "ann")?.computer).toBe("home");
});

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discordYamlPath,
  EMPTY_SETUP,
  opsIds,
  readDiscordSetup,
  writeDiscordSetup,
} from "../src/discord-setup/discord-setup-config";
import { assertTempHome } from "./helpers";

const tmpHome = () => {
  const home = mkdtempSync(join(tmpdir(), "friday-dsc-"));
  assertTempHome(home);
  return home;
};
const A = "100000000000000001";
const B = "100000000000000002";
const C = "100000000000000003";

test("missing discord.yaml means no ops channels", () => {
  expect(readDiscordSetup(tmpHome())).toEqual(EMPTY_SETUP);
});

test("write then read roundtrips; controlChannels defaults to [ops.control]", () => {
  const home = tmpHome();
  writeDiscordSetup(home, { ops: { categoryId: A, control: B, log: C }, controlChannels: [B] });
  const first = readFileSync(discordYamlPath(home), "utf8");
  expect(readDiscordSetup(home)).toEqual({
    ops: { categoryId: A, control: B, log: C },
    controlChannels: [B],
  });
  writeDiscordSetup(home, readDiscordSetup(home));
  expect(readFileSync(discordYamlPath(home), "utf8")).toBe(first); // deterministic
  writeFileSync(discordYamlPath(home), `ops:\n  control: "${B}"\n`);
  expect(readDiscordSetup(home).controlChannels).toEqual([B]);
  writeFileSync(discordYamlPath(home), `ops:\n  log: "${C}"\n`);
  expect(readDiscordSetup(home).controlChannels).toEqual([]);
});

test("unparsable or invalid discord.yaml throws (startup refusal)", () => {
  const home = tmpHome();
  for (const bad of [
    "ops: [unclosed",
    "ops:\n  control: 123\n",
    "controlChannels: nope\n",
    "- a\n- b\n",
  ]) {
    writeFileSync(discordYamlPath(home), bad);
    expect(() => readDiscordSetup(home)).toThrow(/discord.yaml/);
  }
});

test("opsIds collects every ops and control id", () => {
  expect(opsIds({ ops: { categoryId: A, log: B }, controlChannels: [C] })).toEqual(
    new Set([A, B, C]),
  );
  expect(opsIds(EMPTY_SETUP).size).toBe(0);
});

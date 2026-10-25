import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_SCHEMA_KEYS, PLACEHOLDER } from "../src/config/agent-config";

const text = readFileSync(join(import.meta.dir, "../../../.env.example"), "utf8");
const lines = text.split("\n");
/** The key of a `KEY=value` line, commented out or not. */
const keyOf = (l: string) => /^#?\s*([A-Z0-9_]+)=/.exec(l)?.[1];

test(".env.example holds no Discord key", () => {
  expect(text).not.toMatch(/DISCORD/);
});

test(".env.example lists every env key the engine reads", () => {
  const listed = new Set(lines.map(keyOf).filter(Boolean));
  expect(ENV_SCHEMA_KEYS.filter((k) => !listed.has(k))).toEqual([]);
});

test(".env.example secrets are placeholders", () => {
  for (const k of [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "AUTH_SECRET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ])
    expect(lines).toContain(`${k}=${PLACEHOLDER}`);
});

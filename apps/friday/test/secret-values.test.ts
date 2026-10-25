import { expect, test } from "bun:test";
import { redactSecrets } from "@friday/core";
import { deniedEnvValues } from "../src/secret-values";

const env = {
  CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-value-123",
  AUTH_SECRET: "auth-secret-value-456",
  AGENT_HOME: "/home/owner/.friday",
  MODEL: "claude-opus-4-1-20250805",
  WEB_ORIGIN: "https://friday.example.com",
  PATH: "/usr/bin:/bin:/usr/local/bin",
};

test("only denied secret-like env values are collected", () => {
  expect(deniedEnvValues(env).sort()).toEqual(["auth-secret-value-456", "oauth-token-value-123"]);
});

test("a token is redacted; a path under AGENT_HOME and a model id survive", () => {
  const text = `at /home/owner/.friday/scratch/a on claude-opus-4-1-20250805 with oauth-token-value-123`;
  expect(redactSecrets(text, deniedEnvValues(env))).toBe(
    "at /home/owner/.friday/scratch/a on claude-opus-4-1-20250805 with [redacted]",
  );
});

import { expect, test } from "bun:test";
import { gitMcpServerConfig, gitServerEnv } from "../src/mcp/git-mcp";

test("server env: stdio, no signing, no prompts, no commit identity (reads only)", () => {
  const env = gitServerEnv();
  expect(env).toMatchObject({
    GIT_SIGN_COMMITS: "false",
    GIT_TERMINAL_PROMPT: "0",
    MCP_TRANSPORT_TYPE: "stdio",
  });
  expect(env.GIT_AUTHOR_NAME).toBeUndefined();
  expect(env.GIT_AUTHOR_EMAIL).toBeUndefined();
  expect(env.GIT_BASE_DIR).toBeUndefined();
});

test("server config: the pinned package run by this runtime, not npx", () => {
  const cfg = gitMcpServerConfig();
  expect(cfg.command).toBe(process.execPath);
  expect(cfg.args[0]).toContain("git-mcp-server");
  expect(cfg.env).toEqual(gitServerEnv());
});

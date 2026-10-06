import { expect, test } from "bun:test";
import { createGitMcp, gitMcpServerConfig, gitServerEnv } from "../src/mcp/git-mcp";
import { makeRepo } from "./git-fixture";

test("server env: identity as author AND committer, sandbox dir, no signing, no prompts", () => {
  const env = gitServerEnv({ author: { name: "Owner", email: "o@x.dev" }, baseDir: "/w" });
  expect(env).toMatchObject({
    GIT_AUTHOR_NAME: "Owner",
    GIT_COMMITTER_NAME: "Owner",
    GIT_AUTHOR_EMAIL: "o@x.dev",
    GIT_COMMITTER_EMAIL: "o@x.dev",
    GIT_BASE_DIR: "/w",
    GIT_SIGN_COMMITS: "false",
    GIT_TERMINAL_PROMPT: "0",
    MCP_TRANSPORT_TYPE: "stdio",
  });
  expect(gitServerEnv().GIT_AUTHOR_EMAIL).toBeUndefined(); // no identity unless configured
  const cfg = gitMcpServerConfig();
  expect(cfg.args[0]).toContain("git-mcp-server"); // the pinned package, not npx
});

test("real server: a failing tool throws a short message; the client restarts cleanly", async () => {
  const git = createGitMcp();
  const r = await makeRepo("main");
  expect((await git.call("git_branch", { path: r.repo, mode: "show-current" })).currentBranch).toBe(
    "main",
  );
  await expect(git.call("git_status", { path: r.root })).rejects.toThrow(/git_status failed/); // not a repo
  await git.close();
  expect((await git.call("git_status", { path: r.repo })).currentBranch).toBe("main"); // reconnects
  await git.close();
});

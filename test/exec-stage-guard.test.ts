import { afterAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createGitMcp } from "../src/mcp/git-mcp";
import { runStages } from "../src/orchestrator/engine/stage-runner";
import { LEGACY_WT_FIELDS } from "./git-fixture";
import { makeEnv, stubGateway } from "./helpers";

const git = createGitMcp();
afterAll(() => git.close());

/**
 * runStages called directly with a worktree row (routeTask is bypassed, so its earlier refusal cannot
 * hide the exec-stage guard): the workspace's repo `real` has another clone path than the worktree's.
 */
test("execStage refuses when the resolved repo path differs from the worktree's repoPath", async () => {
  const env = makeEnv();
  const mine = join(env.home, "mine");
  const theirs = join(env.home, "theirs");
  mkdirSync(mine);
  mkdirSync(theirs);
  let ran = false;
  const res = await runStages(
    {
      git,
      db: env.db,
      config: env.config,
      approvals: stubGateway(),
      queryFn: ((_a: unknown) => {
        ran = true;
        return (async function* () {})();
      }) as never,
    },
    {
      taskId: "t1",
      role: "dev",
      threadId: "th1",
      text: "go",
      workspace: "w",
      repos: [
        {
          name: "real",
          workspace: "w",
          dir: join(env.home, "w", "real"),
          path: mine,
          description: "",
          gitAuthor: "A <a@example.com>",
        } as never,
      ],
      ac: new AbortController(),
      worktree: {
        taskId: "t0",
        threadId: "th1",
        repo: "real",
        repoPath: theirs,
        path: join(theirs, "wt"),
        branch: "b",
        base: "main",
        prUrl: null,
        createdAt: 0,
        ...LEGACY_WT_FIELDS,
      },
    },
  );
  expect(res.text).toContain("another workspace");
  expect(ran).toBe(false);
});

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { PLACEHOLDER } from "../src/config/agent-config";
import { workspacePaths } from "../src/config/workspace-paths";
import { createTaskHandler } from "../src/orchestrator/handle-task";
import { getWorktreeByThread } from "../src/storage/worktree-store";
import { g, makeRepo } from "./git-fixture";
import { addRepo, clearWorkspaces, makeEnv, stubGateway, TEST_CHANNEL } from "./helpers";

// Live test: Q&A agent delegates -> plan -> approve -> worktree -> agent edits + commits in the worktree (real SDK, OpenRouter).
const key = process.env.OPENROUTER_API_KEY;
const live = !!key && key !== PLACEHOLDER;
if (!live) {
  process.stderr.write("SKIP live code-flow smoke: OPENROUTER_API_KEY missing or REPLACE_ME\n");
}

describe.skipIf(!live)("live worktree code flow (OpenRouter)", () => {
  test("agent picks repo, works in the worktree and commits; PR offer declined", async () => {
    const env = makeEnv({
      OPENROUTER_API_KEY: key!,
      LLM_PROVIDER: "openrouter",
      MAX_TURNS: "20",
      TIMEOUT_MS: "180000",
    });
    const src = await makeRepo("main");
    clearWorkspaces(env.home);
    const clone = workspacePaths(env.home).workspace("main").repo("notes").clone;
    addRepo(
      env.home,
      "notes",
      { description: "tiny notes repo with a.txt", gitAuthor: "Test User <test@example.com>" },
      { path: clone },
    );
    await g(env.home, "clone", "-q", src.repo, clone);
    await g(clone, "config", "user.email", "test@example.com");
    await g(clone, "config", "user.name", "t");
    const asked: string[] = [];
    const gw = stubGateway({
      request: async (r) => (
        asked.push(`request:${r.tool}:${r.summary.slice(0, 60)}`), { approved: true }
      ),
      requestPlan: async () => (asked.push("plan"), { approved: true }),
      confirm: async () => (asked.push("confirm"), { approved: false, reason: "owner declined" }),
      askChoice: async (a) => a.options[0],
    });
    const handle = createTaskHandler({ db: env.db, config: env.config, approvals: gw });
    const reply = await handle({
      source: "test",
      channelId: TEST_CHANNEL,
      userId: "u",
      threadId: "live-flow1",
      text: "Create a file named hello.txt containing exactly the word hi, and commit it.",
    });

    const wt = getWorktreeByThread(env.db, "live-flow1");
    process.stderr.write(
      `live flow: asked=${JSON.stringify(asked)}\nreply=${reply.slice(0, 300)}\n`,
    );
    expect(wt).not.toBeNull();
    expect(readdirSync(wt!.path)).toContain("hello.txt");
    expect(Number(await g(wt!.path, "rev-list", "--count", `${wt!.base}..HEAD`))).toBeGreaterThan(
      0,
    );
    expect(asked).toContain("plan");
    expect(await g(clone, "status", "--short")).toBe("");
  }, 300_000);
});

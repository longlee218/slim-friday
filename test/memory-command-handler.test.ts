import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import { createMemoryRunner, type MemoryRequest } from "../src/memory/memory-command-handler";
import { repoMemoryFile } from "../src/memory/repo-memory";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { addRepo, makeEnv, TEST_CHANNEL } from "./helpers";
import { writeRepoNotes } from "./memory-fixture";

/** Env with workspace main (channel TEST_CHANNEL) and a runner on it. */
function setup(extraRepos: string[] = []) {
  const env = makeEnv();
  for (const r of extraRepos) addRepo(env.home, r);
  const run = createMemoryRunner({ db: env.db, config: env.config });
  const ask = (text: string, over: Partial<MemoryRequest> = {}) =>
    run({ where: "workspace", channelId: TEST_CHANNEL, text, ...over });
  const file = (r: string) => readFileSync(repoMemoryFile(env.home, "main", r), "utf8");
  return { env, ask, run, file };
}

test("not a command -> null (normal task)", async () => {
  const { ask } = setup();
  expect(await ask("what does the repo do?")).toBeNull();
});

test("remember: / nhớ: / /remember are not app commands: null, nothing written (the message goes to the agent)", async () => {
  const { env, ask, run, file } = setup(["web"]);
  writeRepoNotes(env.home, "main", "repo", ["existing note"]);
  const before = file("repo");
  for (const t of [
    "remember: tests run with bun test",
    "nhớ: chung global fact",
    "remember: repo:web a fact",
    "/remember use pnpm in repo web",
    "remember:",
  ])
    expect(await ask(t)).toBeNull();
  expect(
    await run({ where: "control", channelId: "c", text: "remember: global abc def" }),
  ).toBeNull();
  expect(file("repo")).toBe(before);
  expect(await Bun.file(workspacePaths(env.home).memory).exists()).toBe(false);
});

test("forget: one match removed (empty section dropped), none, several", async () => {
  const { env, ask, file } = setup();
  writeRepoNotes(env.home, "main", "repo", ["alpha one note", "alpha two note", "beta lone note"]);
  const several = await ask("forget: alpha");
  expect(several).toContain("2 lines match");
  expect(file("repo")).toContain("alpha one note");
  expect(await ask("forget: gamma")).toContain("not found");
  const one = await ask("forget: BETA lone");
  expect(one).toContain("Forgot");
  expect(file("repo")).not.toContain("beta lone");
  await ask("forget: alpha one");
  await ask("forget: alpha two");
  expect(file("repo")).not.toContain("## "); // the empty section was dropped
});

test("forget reply names the file and chars/cap; secrets are never needed to find a note", async () => {
  const { env, ask } = setup();
  writeRepoNotes(env.home, "main", "repo", ["tests run with bun test"]);
  const r = await ask("forget: bun test");
  expect(r).toContain("workspaces/main/repos/repo/MEMORY.md");
  expect(r).toMatch(/\d+\/8000/);
});

test("forget scopes: workspace/ws, global/chung, repo:<n> (case-insensitive), unknown repo", async () => {
  const { env, ask, file } = setup(["web"]);
  const p = workspacePaths(env.home);
  writeFileSync(p.workspace("main").memory, "# w\n\n## d\n- fact for everyone here\n");
  writeFileSync(p.memory, "# g\n\n## d\n- global fact\n");
  writeRepoNotes(env.home, "main", "web", ["web fact"]);
  expect(await ask("forget: ws fact for everyone")).toContain("Forgot");
  expect(readFileSync(p.workspace("main").memory, "utf8")).not.toContain("fact for everyone");
  expect(await ask("quên: chung global fact")).toContain("Forgot");
  expect(readFileSync(p.memory, "utf8")).not.toContain("global fact");
  expect(await ask("forget: repo:WEB web fact")).toContain("Forgot");
  expect(file("web")).not.toContain("web fact");
  const bad = await ask("forget: repo:nope x y z");
  expect(bad).toContain("Unknown repo");
  expect(bad).toContain("`repo`");
});

test("forget with several repos and no thread context: asks which repo, removes nothing", async () => {
  const { env, ask, file } = setup(["web"]);
  writeRepoNotes(env.home, "main", "repo", ["something useful"]);
  const r = (await ask("forget: something useful")) ?? "";
  expect(r).toContain("Which repo?");
  expect(file("repo")).toContain("something useful");
});

test("in a thread the default repo is the latest task's repo", async () => {
  const { env, ask, file } = setup(["web"]);
  writeRepoNotes(env.home, "main", "web", ["thread default"]);
  writeRepoNotes(env.home, "main", "repo", ["thread default"]);
  env.db
    .query(
      "INSERT INTO turns (id, thread_id, source, repo, type, status, started_at) VALUES ('t1','th1','discord','web','qa','done',1)",
    )
    .run();
  env.db
    .query(
      "INSERT INTO turns (id, thread_id, source, repo, type, status, started_at) VALUES ('t2','th1','discord','*','qa','done',2)",
    )
    .run();
  await ask("forget: thread default", { threadId: "th1" });
  expect(file("web")).not.toContain("thread default");
  expect(file("repo")).toContain("thread default");
});

test("places: control = global only, other ops channel and unmapped channel refuse", async () => {
  const { env, run } = setup();
  const p = workspacePaths(env.home);
  writeFileSync(p.memory, "# g\n\n## d\n- from control\n");
  const ctl = (text: string) => run({ where: "control", channelId: "c", text });
  expect(await ctl("forget: global from control")).toContain("MEMORY.md");
  expect(await ctl("forget: ws nope nope")).toContain("only the global memory");
  expect(await ctl("forget: some default text")).toContain("only the global memory");
  expect(await run({ where: "ops", channelId: "x", text: "forget: global abc" })).toContain(
    "workspace channel",
  );
  expect(
    await run({ where: "workspace", channelId: "300000000000000009", text: "forget: abc def" }),
  ).toContain("not linked");
});

test("invalid command replies with usage (no remember form) and removes nothing", async () => {
  const { ask } = setup();
  const r = (await ask("forget: ab")) ?? "";
  expect(r).toContain("3-100");
  expect(r).not.toContain("/remember [");
});

test("via handleMessage: forget is answered without any task row or agent call; remember reaches the agent", async () => {
  const env = makeEnv();
  writeRepoNotes(env.home, "main", "repo", ["via handler note"]);
  let called = 0;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: () => {
      called++;
      throw new Error("agent must not run");
    },
  });
  const msg = (text: string) => ({
    source: "discord" as const,
    userId: "1",
    threadId: "th",
    channelId: TEST_CHANNEL,
    text,
  });
  const reply = await handle(msg("forget: via handler"));
  expect(reply).toContain("Forgot");
  expect(called).toBe(0);
  expect(env.db.query("SELECT COUNT(*) AS n FROM turns").get()).toEqual({ n: 0 });
  // remember: is no command: the agent run is attempted (the fake throws, proving the message was not answered by app code).
  await handle(msg("remember: via handler again")).catch(() => undefined);
  expect(called).toBeGreaterThan(0);
});

test("forget: bare repo name as first word selects that repo; case-insensitive", async () => {
  const { env, ask, file } = setup(["friday-slim-agent"]);
  writeRepoNotes(env.home, "main", "friday-slim-agent", ["Trả lời lại cho tôi", "another note"]);
  const r = await ask("forget:friday-slim-agent Trả lời lại cho tôi");
  expect(r).toContain("workspaces/main/repos/friday-slim-agent/MEMORY.md");
  expect(file("friday-slim-agent")).not.toContain("Trả lời lại");
  await ask("forget: FRIDAY-Slim-Agent another note");
  expect(file("friday-slim-agent")).not.toContain("another note");
});

test("length rules apply after the repo word is stripped", async () => {
  const { ask } = setup(["web"]);
  expect(await ask("forget: web ab")).toContain("must be 3-100 chars (got 2)");
  expect(await ask("forget: web")).toContain("got 0");
  expect(await ask(`forget: ${"x".repeat(101)}`)).toContain("got 101");
});

test("workspace/global words win over a repo with the same name", async () => {
  const { env, ask, file } = setup(["ws", "chung"]);
  const p = workspacePaths(env.home);
  writeFileSync(p.workspace("main").memory, "# w\n\n## d\n- scoped to workspace\n");
  writeRepoNotes(env.home, "main", "ws", ["scoped to workspace"]);
  expect(await ask("forget: ws scoped to workspace")).toContain("Forgot");
  expect(readFileSync(p.workspace("main").memory, "utf8")).not.toContain("scoped");
  expect(file("ws")).toContain("scoped to workspace");
});

test("'Which repo?' lists repos and the forget forms", async () => {
  const { ask } = setup(["web"]);
  const r = (await ask("forget: something useful")) ?? "";
  expect(r).toContain("`repo`, `web`");
  expect(r).toContain("/forget <repo-name> <text>");
  expect(r).toContain("/forget repo:<name> <text>");
  expect(r).toContain("`ws`");
  expect(r).toContain("`chung`");
});

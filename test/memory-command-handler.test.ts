import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import { createMemoryRunner, type MemoryRequest } from "../src/memory/memory-command-handler";
import { repoMemoryFile } from "../src/memory/repo-memory";
import { createTaskHandler } from "../src/tasks/handle-task";
import { addRepo, makeEnv, TEST_CHANNEL } from "./helpers";

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

test("remember with a single repo: written under '## <date> owner', reply names file and chars/cap", async () => {
  const { ask, file } = setup();
  const r = await ask("remember: tests run with bun test");
  expect(r).toContain("workspaces/main/repos/repo/MEMORY.md");
  expect(r).toMatch(/\d+\/4000/);
  const date = new Date().toISOString().slice(0, 10);
  expect(file("repo")).toContain(`## ${date} owner\n- tests run with bun test`);
  // second note reuses the last owner section
  await ask("remember: second note here");
  expect(file("repo").split(`## ${date} owner`).length).toBe(2);
  // duplicate
  expect(await ask("remember: second note here")).toContain("already remembered");
});

test("secrets are redacted in the stored note", async () => {
  const { ask, file } = setup();
  await ask("remember: key is sk-ant-abcdefghijklmnop1234 ok");
  expect(file("repo")).not.toContain("sk-ant-abcdefghijklmnop1234");
});

test("scopes: workspace/ws, global/chung, repo:<n> (case-insensitive), unknown repo", async () => {
  const { env, ask, file } = setup(["web"]);
  await ask("remember: ws fact for everyone here");
  expect(readFileSync(workspacePaths(env.home).workspace("main").memory, "utf8")).toContain(
    "- fact for everyone here",
  );
  await ask("nhớ: chung global fact");
  const root = readFileSync(workspacePaths(env.home).memory, "utf8");
  expect(root).toContain("- global fact");
  await ask("remember: repo:WEB web fact");
  expect(file("web")).toContain("- web fact");
  const bad = await ask("remember: repo:nope x y z");
  expect(bad).toContain("Unknown repo");
  expect(bad).toContain("`repo`");
  // pending file is never a target
  expect(await Bun.file(workspacePaths(env.home).memoryPending).exists()).toBe(false);
});

test("several repos and no thread context: asks which repo, writes nothing", async () => {
  const { ask, file } = setup(["web"]);
  const r = await ask("remember: something useful");
  expect(r).toContain("Which repo?");
  expect(file("repo")).not.toContain("something useful");
  expect(file("web")).not.toContain("something useful");
});

test("in a thread the default repo is the latest task's repo", async () => {
  const { env, ask, file } = setup(["web"]);
  env.db
    .query(
      "INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at) VALUES ('t1','th1','discord','web','qa','done',1)",
    )
    .run();
  env.db
    .query(
      "INSERT INTO tasks (id, thread_id, source, repo, type, status, started_at) VALUES ('t2','th1','discord','*','qa','done',2)",
    )
    .run();
  await ask("remember: thread default", { threadId: "th1" });
  expect(file("web")).toContain("- thread default");
  expect(file("repo")).not.toContain("thread default");
});

test("forget: one match removed (empty section dropped), none, several", async () => {
  const { ask, file } = setup();
  await ask("remember: alpha one note");
  await ask("remember: alpha two note");
  await ask("remember: beta lone note");
  const several = await ask("forget: alpha");
  expect(several).toContain("2 lines match");
  expect(file("repo")).toContain("alpha one note");
  expect(await ask("forget: gamma")).toContain("not found");
  const one = await ask("forget: BETA lone");
  expect(one).toContain("Forgot");
  expect(file("repo")).not.toContain("beta lone");
  await ask("forget: alpha one");
  await ask("forget: alpha two");
  expect(file("repo")).not.toContain("## "); // the empty owner section was dropped
});

test("storage limit: owner write refused at 300 lines, never trimmed", async () => {
  const { env, ask, file } = setup();
  const f = repoMemoryFile(env.home, "main", "repo");
  writeFileSync(
    f,
    `# repo memory\n\n## old\n${Array.from({ length: 300 }, (_, i) => `- n${i}`).join("\n")}\n`,
  );
  const r = await ask("remember: one more");
  expect(r).toContain("file full");
  expect(r).toContain("compact memory");
  expect(file("repo")).toContain("- n0");
});

test("cap feedback: >80% suggests compaction, >100% says how many chars are out of prompts", async () => {
  const { env, ask } = setup();
  const f = repoMemoryFile(env.home, "main", "repo");
  writeFileSync(f, `# repo memory\n\n## old\n${"- x\n".repeat(1)}${"- ".padEnd(3300, "y")}\n`);
  expect(await ask("remember: tip note")).toContain("Run `compact memory`");
  writeFileSync(f, `# repo memory\n\n## old\n${"- ".padEnd(4500, "y")}\n`);
  expect(await ask("remember: tip two")).toMatch(/\d+ oldest chars are not in prompts/);
});

test("places: control = global only, other ops channel and unmapped channel refuse", async () => {
  const { env, run, file } = setup();
  const ctl = (text: string) => run({ where: "control", channelId: "c", text });
  expect(await ctl("remember: global from control")).toContain("MEMORY.md");
  expect(readFileSync(workspacePaths(env.home).memory, "utf8")).toContain("- from control");
  expect(await ctl("remember: ws nope nope")).toContain("only the global memory");
  expect(await ctl("remember: some default text")).toContain("only the global memory");
  expect(await run({ where: "ops", channelId: "x", text: "remember: global abc" })).toContain(
    "workspace channel",
  );
  expect(
    await run({ where: "workspace", channelId: "300000000000000009", text: "remember: abc def" }),
  ).toContain("not linked");
  expect(file("repo")).not.toContain("abc def");
});

test("invalid command replies with usage and writes nothing", async () => {
  const { ask } = setup();
  expect(await ask("remember: ab")).toContain("3-300");
});

test("via handleTask: answered without any task row, quota slot or agent call", async () => {
  const env = makeEnv();
  let called = false;
  const handle = createTaskHandler({
    db: env.db,
    config: env.config,
    queryFn: () => {
      called = true;
      throw new Error("agent must not run");
    },
  });
  const reply = await handle({
    source: "discord",
    userId: "1",
    threadId: "th",
    channelId: TEST_CHANNEL,
    text: "remember: via handler",
  });
  expect(reply).toContain("Remembered");
  expect(called).toBe(false);
  expect(env.db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
});

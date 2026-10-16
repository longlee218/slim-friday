import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { workspacePaths } from "../src/config/workspace-paths";
import { locationMemoryFile } from "../src/memory/location-memory";
import { createMemoryRunner, type MemoryRequest } from "../src/memory/memory-command-handler";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { addLocation, makeEnv, TEST_CHANNEL } from "./helpers";
import { until } from "./lead-harness";
import { writeLocationNotes } from "./memory-fixture";

/** Env with workspace main (channel TEST_CHANNEL) and a runner on it. */
function setup(extraLocations: string[] = []) {
  const env = makeEnv();
  for (const r of extraLocations) addLocation(env.home, r);
  const run = createMemoryRunner({ db: env.db, config: env.config });
  const ask = (text: string, over: Partial<MemoryRequest> = {}) =>
    run({ where: "workspace", channelId: TEST_CHANNEL, text, ...over });
  const file = (r: string) => readFileSync(locationMemoryFile(env.home, "main", r), "utf8");
  return { env, ask, run, file };
}

test("not a command -> null (normal task)", async () => {
  const { ask } = setup();
  expect(await ask("what does the location do?")).toBeNull();
});

test("remember: / nhớ: / /remember are not app commands: null, nothing written (the message goes to the agent)", async () => {
  const { env, ask, run, file } = setup(["web"]);
  writeLocationNotes(env.home, "main", "location", ["existing note"]);
  const before = file("location");
  for (const t of [
    "remember: tests run with bun test",
    "nhớ: chung global fact",
    "remember: location:web a fact",
    "/remember use pnpm in location web",
    "remember:",
  ])
    expect(await ask(t)).toBeNull();
  expect(
    await run({ where: "control", channelId: "c", text: "remember: global abc def" }),
  ).toBeNull();
  expect(file("location")).toBe(before);
  expect(await Bun.file(workspacePaths(env.home).memory).exists()).toBe(false);
});

test("forget: one match removed (empty section dropped), none, several", async () => {
  const { env, ask, file } = setup();
  writeLocationNotes(env.home, "main", "location", [
    "alpha one note",
    "alpha two note",
    "beta lone note",
  ]);
  const several = await ask("forget: alpha");
  expect(several).toContain("2 lines match");
  expect(file("location")).toContain("alpha one note");
  expect(await ask("forget: gamma")).toContain("not found");
  const one = await ask("forget: BETA lone");
  expect(one).toContain("Forgot");
  expect(file("location")).not.toContain("beta lone");
  await ask("forget: alpha one");
  await ask("forget: alpha two");
  expect(file("location")).not.toContain("## "); // the empty section was dropped
});

test("forget reply names the file and chars/cap; secrets are never needed to find a note", async () => {
  const { env, ask } = setup();
  writeLocationNotes(env.home, "main", "location", ["tests run with bun test"]);
  const r = await ask("forget: bun test");
  expect(r).toContain("workspaces/main/locations/location/MEMORY.md");
  expect(r).toMatch(/\d+\/8000/);
});

test("forget scopes: workspace/ws, global/chung, location:<n> (case-insensitive), unknown location", async () => {
  const { env, ask, file } = setup(["web"]);
  const p = workspacePaths(env.home);
  writeFileSync(p.workspace("main").memory, "# w\n\n## d\n- fact for everyone here\n");
  writeFileSync(p.memory, "# g\n\n## d\n- global fact\n");
  writeLocationNotes(env.home, "main", "web", ["web fact"]);
  expect(await ask("forget: ws fact for everyone")).toContain("Forgot");
  expect(readFileSync(p.workspace("main").memory, "utf8")).not.toContain("fact for everyone");
  expect(await ask("quên: chung global fact")).toContain("Forgot");
  expect(readFileSync(p.memory, "utf8")).not.toContain("global fact");
  expect(await ask("forget: location:WEB web fact")).toContain("Forgot");
  expect(file("web")).not.toContain("web fact");
  const bad = await ask("forget: location:nope x y z");
  expect(bad).toContain("Unknown location");
  expect(bad).toContain("`location`");
});

test("forget with several locations and no thread context: asks which location, removes nothing", async () => {
  const { env, ask, file } = setup(["web"]);
  writeLocationNotes(env.home, "main", "location", ["something useful"]);
  const r = (await ask("forget: something useful")) ?? "";
  expect(r).toContain("Which location?");
  expect(file("location")).toContain("something useful");
});

test("in a thread the default location is the latest task's location", async () => {
  const { env, ask, file } = setup(["web"]);
  writeLocationNotes(env.home, "main", "web", ["thread default"]);
  writeLocationNotes(env.home, "main", "location", ["thread default"]);
  env.db
    .query(
      "INSERT INTO turns (id, thread_id, source, location, status, started_at, role) VALUES ('t1','th1','discord','web','done',1,'lead')",
    )
    .run();
  env.db
    .query(
      "INSERT INTO turns (id, thread_id, source, location, status, started_at, role) VALUES ('t2','th1','discord','*','done',2,'lead')",
    )
    .run();
  await ask("forget: thread default", { threadId: "th1" });
  expect(file("web")).not.toContain("thread default");
  expect(file("location")).toContain("thread default");
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

test("via handleMessage: forget is answered without any task row or agent call; remember reaches the lead", async () => {
  const env = makeEnv();
  writeLocationNotes(env.home, "main", "location", ["via handler note"]);
  let called = 0;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    leadTiming: { debounceMs: 10, announceWindowMs: 20 },
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
  // remember: is no command: the lead run is attempted (the fake throws, proving the message was not answered by app code).
  await handle(msg("remember: via handler again")).catch(() => undefined);
  await until(() => called > 0);
});

test("forget: bare location name as first word selects that location; case-insensitive", async () => {
  const { env, ask, file } = setup(["friday-slim-agent"]);
  writeLocationNotes(env.home, "main", "friday-slim-agent", [
    "Trả lời lại cho tôi",
    "another note",
  ]);
  const r = await ask("forget:friday-slim-agent Trả lời lại cho tôi");
  expect(r).toContain("workspaces/main/locations/friday-slim-agent/MEMORY.md");
  expect(file("friday-slim-agent")).not.toContain("Trả lời lại");
  await ask("forget: FRIDAY-Slim-Agent another note");
  expect(file("friday-slim-agent")).not.toContain("another note");
});

test("length rules apply after the location word is stripped", async () => {
  const { ask } = setup(["web"]);
  expect(await ask("forget: web ab")).toContain("must be 3-100 chars (got 2)");
  expect(await ask("forget: web")).toContain("got 0");
  expect(await ask(`forget: ${"x".repeat(101)}`)).toContain("got 101");
});

test("workspace/global words win over a location with the same name", async () => {
  const { env, ask, file } = setup(["ws", "chung"]);
  const p = workspacePaths(env.home);
  writeFileSync(p.workspace("main").memory, "# w\n\n## d\n- scoped to workspace\n");
  writeLocationNotes(env.home, "main", "ws", ["scoped to workspace"]);
  expect(await ask("forget: ws scoped to workspace")).toContain("Forgot");
  expect(readFileSync(p.workspace("main").memory, "utf8")).not.toContain("scoped");
  expect(file("ws")).toContain("scoped to workspace");
});

test("'Which location?' lists locations and the forget forms", async () => {
  const { ask } = setup(["web"]);
  const r = (await ask("forget: something useful")) ?? "";
  expect(r).toContain("`location`, `web`");
  expect(r).toContain("/forget <location-name> <text>");
  expect(r).toContain("/forget location:<name> <text>");
  expect(r).toContain("`ws`");
  expect(r).toContain("`chung`");
});

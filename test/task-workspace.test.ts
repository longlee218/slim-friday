import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureLogs } from "../src/observability/logger";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { resolveTaskWorkspace, selectWorkspace } from "../src/workspaces/task-workspace";
import type { Workspace } from "../src/workspaces/workspace-registry";
import { addLocation, clearWorkspaces, makeEnv, TEST_CHANNEL } from "./helpers";

const CH_A = "100000000000000011";
const CH_B = "100000000000000022";
const ws = (name: string, channels: string[]): Workspace => ({
  name,
  root: `/x/${name}`,
  description: "",
  channels,
  channelDefs: channels.map((id) => ({ id, name: `${name}-agent`, mode: "task" as const })),
  locations: [],
});

test("resolveTaskWorkspace: one match, none, and no default", () => {
  const list = [ws("a", [CH_A]), ws("b", [CH_B])];
  expect(resolveTaskWorkspace(list, CH_B)?.name).toBe("b");
  expect(resolveTaskWorkspace(list, "100000000000000099")).toBeUndefined();
  expect(resolveTaskWorkspace([], CH_A)).toBeUndefined();
  // Defensive: a channel listed twice (the registry drops those) never routes.
  expect(resolveTaskWorkspace([ws("a", [CH_A]), ws("b", [CH_A])], CH_A)).toBeUndefined();
});

test("selectWorkspace: mapped channel -> its workspace; unmapped -> exact refusal", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  addLocation(env.home, "r1", {}, { workspace: "alpha", channels: [CH_A] });
  addLocation(env.home, "r2", {}, { workspace: "beta", channels: [CH_B] });
  const a = selectWorkspace(env.home, CH_A);
  expect("ws" in a && a.ws.name).toBe("alpha");
  const un = selectWorkspace(env.home, "100000000000000077");
  expect(un).toEqual({
    reason: "unmapped_channel",
    reply:
      "This channel is not linked to a workspace. Add its id `100000000000000077` to `channels:` in workspaces/<ws>/workspace.yaml (or run `/init-workspace <name>` in #ops-control).",
  });
});

test("selectWorkspace: a workspace with 0 locations works (cwd dir)", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const w = join(env.home, "workspaces", "empty");
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, "workspace.yaml"), `channels:\n  - "${TEST_CHANNEL}"\n`);
  const r = selectWorkspace(env.home, TEST_CHANNEL);
  expect("ws" in r && r.ws.locations).toEqual([]);
});

test("selectWorkspace: a workspace that still has repos/<n>/repo.yaml needs the migration", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const w = join(env.home, "workspaces", "old");
  mkdirSync(join(w, "repos", "api"), { recursive: true });
  writeFileSync(join(w, "repos", "api", "repo.yaml"), "path: /x\n");
  writeFileSync(join(w, "workspace.yaml"), `channels:\n  - "${TEST_CHANNEL}"\n`);
  const r = selectWorkspace(env.home, TEST_CHANNEL);
  expect("reason" in r && r.reason).toBe("needs_migration");
  expect("reply" in r && r.reply).toContain("bun run migrate:locations");
});

test("handler: unmapped channel is refused before any task row or agent run", async () => {
  const env = makeEnv();
  let ran = false;
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    queryFn: ((_a: unknown) => {
      ran = true;
      return (async function* () {})();
    }) as never,
  });
  const reply = await handle({
    source: "t",
    channelId: "100000000000000077",
    userId: "u",
    threadId: "th",
    text: "hello",
  });
  expect(reply).toContain("This channel is not linked to a workspace");
  expect(reply).toContain("`100000000000000077`");
  expect(ran).toBe(false);
  expect(env.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 0 });
});

test("handler: mapped channel whose workspace still has repos/ -> migration refusal, logs channelId", async () => {
  const env = makeEnv();
  mkdirSync(join(env.home, "workspaces", "main", "repos", "old"), { recursive: true });
  writeFileSync(join(env.home, "workspaces", "main", "repos", "old", "repo.yaml"), "path: /x\n");
  const handle = createTurnHandler({ db: env.db, config: env.config });
  const cap = captureLogs();
  const reply = await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th",
    text: "hello",
  });
  cap.stop();
  expect(reply).toContain("bun run migrate:locations");
  // task.routed and task.refused both carry the routing channel.
  for (const event of ["task.routed", "task.refused"])
    expect(cap.lines.find((l) => l.event === event)).toMatchObject({ channelId: TEST_CHANNEL });
  expect(env.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 0 });
});

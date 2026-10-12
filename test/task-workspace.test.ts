import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureLogs } from "../src/observability/logger";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { resolveTaskWorkspace, selectWorkspace } from "../src/workspaces/task-workspace";
import type { Workspace } from "../src/workspaces/workspace-registry";
import { addRepo, clearWorkspaces, makeEnv, TEST_CHANNEL } from "./helpers";

const CH_A = "100000000000000011";
const CH_B = "100000000000000022";
const ws = (name: string, channels: string[]): Workspace => ({
  name,
  root: `/x/${name}`,
  description: "",
  channels,
  repos: [],
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
  addRepo(env.home, "r1", {}, { workspace: "alpha", channels: [CH_A] });
  addRepo(env.home, "r2", {}, { workspace: "beta", channels: [CH_B] });
  const a = selectWorkspace(env.home, CH_A);
  expect("ws" in a && a.ws.name).toBe("alpha");
  const un = selectWorkspace(env.home, "100000000000000077");
  expect(un).toEqual({
    reason: "unmapped_channel",
    reply:
      "This channel is not linked to a workspace. Add its id `100000000000000077` to `channels:` in workspaces/<ws>/workspace.yaml (or run `/init-workspace <name>` in #ops-control).",
  });
});

test("selectWorkspace: a workspace with 0 repos is refused by name", () => {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const w = join(env.home, "workspaces", "empty");
  mkdirSync(w, { recursive: true });
  writeFileSync(join(w, "workspace.yaml"), `channels:\n  - "${TEST_CHANNEL}"\n`);
  expect(selectWorkspace(env.home, TEST_CHANNEL)).toEqual({
    reason: "no_repos",
    reply: "Workspace empty has no repos. Add workspaces/empty/repos/<name>/repo.yaml.",
  });
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

test("handler: mapped channel whose workspace has no repos any more -> 0-repos refusal, logs channelId", async () => {
  const env = makeEnv();
  rmSync(join(env.home, "workspaces", "main", "repos"), { recursive: true, force: true });
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
  expect(reply).toBe("Workspace main has no repos. Add workspaces/main/repos/<name>/repo.yaml.");
  // task.routed and task.refused both carry the routing channel.
  for (const event of ["task.routed", "task.refused"])
    expect(cap.lines.find((l) => l.event === event)).toMatchObject({ channelId: TEST_CHANNEL });
  expect(env.db.query("SELECT count(*) AS n FROM turns").get()).toEqual({ n: 0 });
});

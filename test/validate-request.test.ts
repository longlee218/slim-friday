import { expect, test } from "bun:test";
import { workspacePaths } from "../src/config/workspace-paths";
import { MAX_CAPPED_TASKS } from "../src/orchestrator/dispatch/task-repo";
import {
  type DispatchRequest,
  LOW_CONFIDENCE,
  validateRequest,
} from "../src/orchestrator/dispatch/validate-request";
import { insertTurn } from "../src/storage/run-store";
import { loadWorkspaces } from "../src/workspaces/workspace-registry";
import { g, makeRepo } from "./git-fixture";
import { addRepo, clearWorkspaces, makeEnv } from "./helpers";

/** Workspace `main` with a managed clone `real` (a real git repo, branch main) and an unmanaged `wc`. */
async function setup() {
  const env = makeEnv();
  clearWorkspaces(env.home);
  const src = await makeRepo("main");
  const clone = workspacePaths(env.home).workspace("main").repo("real").clone;
  addRepo(env.home, "real", {}, { path: clone });
  await g(env.home, "clone", "-q", src.repo, clone);
  const repos = loadWorkspaces(env.home).workspaces[0]!.repos;
  return { env, repos, deps: { db: env.db, config: env.config, repos } };
}

const req = (over: Partial<DispatchRequest> = {}): DispatchRequest => ({
  role: "dev",
  brief: "Add b.txt with two",
  ...over,
});

test("valid dev request: role, candidate clones, row repo `*` until the plan picks, class standard", async () => {
  const { deps, repos } = await setup();
  const v = await validateRequest(deps, req());
  expect(v).toMatchObject({ ok: true, repoName: "*", cls: "standard" });
  if (v.ok) {
    expect(v.role.name).toBe("dev");
    expect(v.candidates).toEqual(repos);
  }
});

test("repo given: resolved through the single resolver; unknown repo asks; an owner checkout outside the workspace clones is accepted", async () => {
  const { deps } = await setup();
  const ok = await validateRequest(deps, req({ repo: "REAL" }));
  expect(ok).toMatchObject({ ok: true, repoName: "real" });
  const bad = await validateRequest(deps, req({ repo: "nope" }));
  expect(bad).toMatchObject({ ok: false, action: "ask", refusal: { reason: "unknown_repo" } });
  expect(bad).toMatchObject({ refusal: { reply: expect.stringContaining('Unknown repo "nope"') } });
  // Any registered repo works (the task clones it): no managed-clone requirement any more.
  const external = await validateRequest(
    { ...deps, repos: [{ ...deps.repos[0]!, path: "/somewhere/else" }] },
    req(),
  );
  expect(external).toMatchObject({ ok: true });
});

test("unknown role asks the owner (never a guess); an answering role is valid (a queued follow-up may be any role)", async () => {
  const { deps } = await setup();
  for (const role of ["nope", "constructor"]) {
    const v = await validateRequest(deps, req({ role }));
    expect(v).toMatchObject({ ok: false, action: "ask", refusal: { reason: "unknown_role" } });
  }
  expect(await validateRequest(deps, req({ role: "assistant" }))).toMatchObject({ ok: true });
});

test("low confidence asks once; `confirmed` (owner said go) skips the question", async () => {
  const { deps } = await setup();
  const low = req({ confidence: LOW_CONFIDENCE - 0.01 });
  expect(await validateRequest(deps, low)).toMatchObject({
    ok: false,
    action: "ask",
    refusal: { reason: "low_confidence" },
  });
  expect(await validateRequest(deps, { ...low, confirmed: true })).toMatchObject({
    ok: true,
  });
  expect(await validateRequest(deps, req({ confidence: LOW_CONFIDENCE }))).toMatchObject({
    ok: true,
  });
});

test("cap: refused when the role counts toward it and the cap is full", async () => {
  const { deps } = await setup();
  for (const id of Array.from({ length: MAX_CAPPED_TASKS }, (_, n) => `cap${n}`))
    insertTurn(deps.db, { id, threadId: id, source: "t", repo: "real", role: "dev" });
  expect(await validateRequest(deps, req())).toMatchObject({
    ok: false,
    action: "refuse",
    refusal: { reason: "code_task_limit", event: "task.busy" },
  });
});

test("budget: a non-positive role budget refuses", async () => {
  const { deps } = await setup();
  const config = { ...deps.config, budgetOverrides: { dev: 0 } };
  expect(await validateRequest({ ...deps, config }, req())).toMatchObject({
    ok: false,
    refusal: { reason: "no_budget" },
  });
});

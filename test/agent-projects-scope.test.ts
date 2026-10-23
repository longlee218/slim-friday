import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { locationPathError } from "../src/locations/location-registry";
import { roleScope } from "../src/orchestrator/run/role-scope";
import { isDeniedPath, realOrSame } from "../src/policy/paths";
import { getRole } from "../src/roles/role-registry";
import { makeEnv } from "./helpers";

/* A project made under <AGENT_HOME>/projects is the one narrow exception to the AGENT_HOME deny: only this run's own
   locations in it are granted back, never the whole dir (a sibling project) and never another AGENT_HOME path. */

const loc = (name: string, path: string) => ({
  name,
  workspace: "main",
  path,
  description: "",
  git: true,
});

for (const roleName of ["developer", "scout"]) {
  test(`${roleName}: own project under <home>/projects is allowed, a sibling and other AGENT_HOME paths stay denied`, () => {
    const env = makeEnv();
    const mine = join(env.paths.projects, "mine");
    const sibling = join(env.paths.projects, "sibling");
    mkdirSync(mine, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const scope = roleScope(
      env.config,
      {
        turnId: "t1",
        threadId: "th",
        text: "x",
        role: getRole(roleName),
        workspace: "main",
        locations: [loc("mine", mine)],
        ac: new AbortController(),
      },
      getRole(roleName),
    );
    const { denyPaths = [], allowInside = [] } = scope.guard ?? {};
    const denied = (p: string) => isDeniedPath(realOrSame(p), denyPaths, allowInside);
    expect(denied(join(mine, "src", "a.ts"))).toBe(false);
    expect(denied(mine)).toBe(false);
    expect(denied(sibling)).toBe(true);
    expect(denied(env.paths.projects)).toBe(true);
    expect(denied(env.paths.dbFile)).toBe(true);
    expect(denied(join(env.home, "projects-x"))).toBe(true);
  });
}

test("locationPathError: strictly inside <home>/projects is accepted, the dir itself and other AGENT_HOME paths are not", () => {
  const env = makeEnv();
  const wsRoot = env.paths.workspace("main").root;
  const inside = join(env.paths.projects, "p");
  const other = join(env.home, "other");
  for (const d of [inside, other]) mkdirSync(d, { recursive: true });
  expect(locationPathError(inside, wsRoot, [env.home], [])).toBeUndefined();
  expect(locationPathError(env.paths.projects, wsRoot, [env.home], [])).toBe(
    "path is inside AGENT_HOME",
  );
  expect(locationPathError(other, wsRoot, [env.home], [])).toBe("path is inside AGENT_HOME");
});

import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { roleScope } from "../src/orchestrator/run/role-scope";
import { getRole } from "../src/roles/role-registry";
import { makeEnv, outsideDir } from "./helpers";

/** Minimal run input for a background (dev) role in workspace `main`. */
const input = (env: ReturnType<typeof makeEnv>, resumeCwd: string, locations = env.location) => ({
  turnId: "t1",
  threadId: "th",
  text: "x",
  role: "developer",
  workspace: "main",
  locations: locations
    ? [{ name: "location", workspace: "main", path: locations, description: "", git: true }]
    : [],
  ac: new AbortController(),
  resume: { sessionId: "s1", cwd: resumeCwd },
});

test("background resume: accepted in a registered location and in the neutral cwd/ of a zero-location workspace", () => {
  const env = makeEnv();
  const dev = getRole("developer");
  const neutral = env.paths.workspace("main").cwd;
  mkdirSync(neutral, { recursive: true });
  // zero locations: the neutral cwd/ is where a dev run works, so it must resume there
  expect(roleScope(env.config, { ...input(env, neutral), locations: [] }, dev).sessionId).toBe(
    "s1",
  );
  expect(roleScope(env.config, input(env, env.location), dev).sessionId).toBe("s1");
});

test("background resume: any other dir is refused", () => {
  const env = makeEnv();
  expect(() => roleScope(env.config, input(env, outsideDir()), getRole("developer"))).toThrow(
    "resume cwd is not a workspace location",
  );
});

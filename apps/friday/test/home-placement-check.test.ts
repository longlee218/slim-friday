import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homePlacementError } from "../src/lifecycle/home-placement-check";

const dirs: string[] = [];
/** Fresh temp dir (never the real home). */
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "hpc-")));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("home outside any location and git tree: fine", () => {
  expect(homePlacementError(tmp(), [tmp()])).toBeUndefined();
  expect(homePlacementError(join(tmp(), "not-created-yet"), [])).toBeUndefined();
});

test("home inside a registered location path: refused", () => {
  const location = tmp();
  const home = join(location, "sub", "friday");
  mkdirSync(home, { recursive: true });
  expect(homePlacementError(home, [location])).toBe("AGENT_HOME is inside a registered location");
  expect(homePlacementError(location, [location])).toBe(
    "AGENT_HOME is inside a registered location",
  );
});

test("home inside a git working tree (ancestor marker, location not registered): refused", () => {
  const tree = tmp();
  mkdirSync(join(tree, ".git"));
  const home = join(tree, "a", "b");
  mkdirSync(home, { recursive: true });
  expect(homePlacementError(home, [])).toBe("AGENT_HOME is inside a git working tree");
  expect(homePlacementError(tree, [])).toBe("AGENT_HOME is inside a git working tree");
});

test("a git marker that is a FILE (submodule / linked worktree) counts too", () => {
  const tree = tmp();
  writeFileSync(join(tree, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
  const home = join(tree, "home");
  mkdirSync(home);
  expect(homePlacementError(home, [])).toBe("AGENT_HOME is inside a git working tree");
});

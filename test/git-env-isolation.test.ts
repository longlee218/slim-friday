import { expect, test } from "bun:test";

// A git hook (pre-push runs `bun test`) exports GIT_DIR and friends; a test that spawns git would
// then write to the real repo (`git init --bare` made it bare, `git config user.*` replaced the
// owner's identity). The test preload drops them, so every spawned git sees only its own repo.
test("no GIT_* variable from a calling git hook reaches the tests", () => {
  expect(Object.keys(process.env).filter((k) => k.startsWith("GIT_"))).toEqual([]);
});

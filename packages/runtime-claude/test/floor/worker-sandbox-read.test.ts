import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInside } from "../../src/floor/paths";
import { denyAround, workerSandbox } from "../../src/floor/worker-sandbox";

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "friday-sandbox-")));
const locked: string[] = [];
afterAll(() => {
  for (const d of locked) chmodSync(d, 0o755);
});

/** A tree: `<root>/<rel>` for each rel (a trailing `/` makes a dir, else a file). */
function tree(rels: string[]): string {
  const root = tmp();
  for (const rel of rels) {
    const p = join(root, rel);
    if (rel.endsWith("/")) mkdirSync(p, { recursive: true });
    else {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "");
    }
  }
  return root;
}

test("a root with nothing to keep is denied whole", () => {
  const root = tree(["a/", "f"]);
  expect(denyAround(root, ["/elsewhere"])).toEqual([root]);
});

test("a root covered by a kept dir is not denied at all", () => {
  const root = tree(["a/"]);
  expect(denyAround(join(root, "a"), [root])).toEqual([]);
});

test("everything around a kept dir is denied, the kept dir and its parents are not", () => {
  const root = tree(["a/grant/x", "a/other/", "b/", "f"]);
  const deny = denyAround(root, [join(root, "a/grant")]).sort();
  expect(deny).toEqual([join(root, "a/other"), join(root, "b"), join(root, "f")]);
});

test("a kept dir deeper than the limit stays under a deny (fail closed)", () => {
  const deep = join("d/".repeat(12));
  const root = tree([`${deep}/`]);
  const kept = join(root, deep);
  expect(denyAround(root, [kept]).some((d) => isInside(d, kept))).toBe(true);
});

test("an unreadable dir on the way to a kept dir is denied whole (fail closed)", () => {
  const root = tree(["a/grant/", "a/other/"]);
  chmodSync(join(root, "a"), 0o000);
  locked.push(join(root, "a"));
  expect(denyAround(root, [join(root, "a/grant")])).toEqual([join(root, "a")]);
});

test("a granted repo with a .env: its root is readable, the .env and the rest of home are not", () => {
  const home = tree([
    "Documents/Work/Repo/.env",
    "Documents/Work/Repo/src/",
    "Documents/Other/",
    ".ssh/",
  ]);
  const repo = join(home, "Documents/Work/Repo");
  const scratch = tmp();
  const fs = workerSandbox(
    { writePaths: [repo], cwd: repo, scratchDir: scratch },
    home,
  )?.filesystem;
  const denyRead = fs?.denyRead ?? [];
  const allowRead = fs?.allowRead ?? [];
  // Nothing denied covers the repo root or its parents, so `ls` of the repo root works.
  for (const p of [repo, join(home, "Documents/Work"), join(home, "Documents"), home])
    expect(denyRead.some((d) => isInside(d, p))).toBe(false);
  // The secret stays denied and nothing allows it back; the rest of home stays denied.
  const env = join(repo, ".env");
  expect(denyRead).toContain(env);
  expect(allowRead.some((a) => isInside(a, env))).toBe(false);
  for (const p of [join(home, "Documents/Other"), join(home, ".ssh")])
    expect(denyRead.some((d) => isInside(d, p))).toBe(true);
});

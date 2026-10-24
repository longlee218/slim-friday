import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Refused } from "../../src/design/design-util";
import { cloneSkillSource, type GitRunner } from "../../src/skills/clone-skill-source";
import { parseSkillSource } from "../../src/skills/skill-source-url";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "clone-test-"));
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

type Call = { argv: string[]; env: Record<string, string> };

/** A fake git: records calls; a clone runs `populate` on the target dir; rev-parse answers a fixed sha. */
function fakeRunner(populate: (repo: string) => void = () => {}, cloneCode = 0) {
  const calls: Call[] = [];
  const run: GitRunner = async (argv, env) => {
    calls.push({ argv, env });
    if (argv.includes("clone")) {
      if (cloneCode !== 0) return { code: cloneCode, out: "", err: "fatal" };
      const repo = argv[argv.length - 1] as string;
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, ".git", "big"), "x".repeat(100));
      populate(repo);
      return { code: 0, out: "", err: "" };
    }
    return { code: 0, out: "abc123\n", err: "" };
  };
  return { run, calls };
}

test.each([
  "http://github.com/a/b",
  "ext::sh -c id",
  "file:///etc",
  "git@github.com:a/b",
  "https://u:p@github.com/a/b",
  "-uhttps://x",
  "ssh://github.com/a/b",
  "https://github.com/a/b c",
])("refuses %s", (s) => expect(() => parseSkillSource(s)).toThrow(Refused));

test("refusal names the field", () => {
  try {
    parseSkillSource("http://x.com/a");
  } catch (e) {
    expect((e as Refused).field).toBe("source");
  }
  try {
    parseSkillSource("https://github.com/a/b", "../x");
  } catch (e) {
    expect((e as Refused).field).toBe("path");
  }
});

test.each(["../x", "a/../b", "/abs", "-x", "a b", ""])("refuses path %p", (p) =>
  expect(() => parseSkillSource("https://github.com/a/b", p)).toThrow(Refused),
);

test("accepts an https url and a relative path", () => {
  expect(parseSkillSource("https://github.com/a/b", "skills/x")).toEqual({
    url: "https://github.com/a/b",
    path: "skills/x",
  });
});

test("git argv restricts protocols and drops credentials", async () => {
  const f = fakeRunner();
  const r = await cloneSkillSource("https://github.com/a/b", {
    tmpRoot,
    pathEnv: "/usr/bin",
    run: f.run,
  });
  const c = f.calls[0] as Call;
  expect(c.argv).toEqual(
    expect.arrayContaining([
      "protocol.allow=never",
      "protocol.https.allow=always",
      "credential.helper=",
      "--no-recurse-submodules",
      "--depth",
    ]),
  );
  expect(c.argv).not.toContain("credential.helper=osxkeychain");
  expect(c.argv).toContain("--");
  expect(c.env.HOME).not.toBe(homedir());
  expect(c.env.PATH).toBe("/usr/bin");
  expect(c.env.GIT_ALLOW_PROTOCOL).toBe("https");
  expect(Object.keys(c.env)).not.toContain("GITHUB_TOKEN");
  expect(r.sha).toBe("abc123");
  r.cleanup();
});

test("too many files: refused and temp dir removed", async () => {
  const f = fakeRunner((repo) => {
    for (let i = 0; i < 5001; i++) writeFileSync(join(repo, `f${i}`), "");
  });
  await expect(
    cloneSkillSource("https://github.com/a/b", { tmpRoot, pathEnv: "/usr/bin", run: f.run }),
  ).rejects.toThrow(Refused);
  expect(readdirSync(tmpRoot)).toEqual([]);
});

test("too big: refused and temp dir removed", async () => {
  const f = fakeRunner((repo) => {
    writeFileSync(join(repo, "big"), "");
    truncateSync(join(repo, "big"), 51 * 1024 * 1024);
  });
  await expect(
    cloneSkillSource("https://github.com/a/b", { tmpRoot, pathEnv: "/usr/bin", run: f.run }),
  ).rejects.toThrow(Refused);
  expect(readdirSync(tmpRoot)).toEqual([]);
});

test("a symlink counts as a file and is not followed", async () => {
  const f = fakeRunner((repo) => {
    symlinkSync(tmpdir(), join(repo, "link"));
  });
  const r = await cloneSkillSource("https://github.com/a/b", {
    tmpRoot,
    pathEnv: "/usr/bin",
    run: f.run,
  });
  r.cleanup();
});

test("git failure: temp dir removed", async () => {
  const f = fakeRunner(() => {}, 128);
  await expect(
    cloneSkillSource("https://github.com/a/b", { tmpRoot, pathEnv: "/usr/bin", run: f.run }),
  ).rejects.toThrow();
  expect(readdirSync(tmpRoot)).toEqual([]);
});

test("cleanup removes the clone", async () => {
  const f = fakeRunner();
  const r = await cloneSkillSource("https://github.com/a/b", {
    tmpRoot,
    pathEnv: "/usr/bin",
    run: f.run,
  });
  expect(readdirSync(tmpRoot).length).toBe(1);
  r.cleanup();
  expect(readdirSync(tmpRoot)).toEqual([]);
});

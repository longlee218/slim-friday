import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
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
import {
  cloneSkillSource,
  defaultGitRunner,
  type GitRunner,
} from "../../src/skills/clone-skill-source";
import { parseSkillSource } from "../../src/skills/skill-source-url";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "clone-test-"));
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

type Call = { argv: string[]; env: Record<string, string> };

/** A fake git: records calls; a clone runs `populate` on the target dir; rev-parse answers a fixed sha. */
function fakeRunner(
  populate: (repo: string) => void = () => {},
  cloneCode = 0,
  lsTree = "100644 blob aaa      10\tf",
) {
  const calls: Call[] = [];
  const run: GitRunner = async (argv, env) => {
    calls.push({ argv, env });
    if (argv.includes("clone")) {
      if (cloneCode !== 0) return { code: cloneCode, out: "", err: "fatal" };
      const repo = argv[argv.length - 1] as string;
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, ".git", "big"), "x".repeat(100));
      return { code: 0, out: "", err: "" };
    }
    if (argv.includes("ls-tree")) return { code: 0, out: lsTree, err: "" };
    if (argv.includes("checkout")) {
      populate(argv[argv.indexOf("-C") + 1] as string);
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
  "https:evil.com/a",
  "https:\\\\evil.com\\a",
  "https:/evil.com/a",
  "https://@github.com/a",
  "HTTPS://github.com/a/b",
])("refuses %s", (s) => expect(() => parseSkillSource(s)).toThrow(Refused));

test("refusal names the field", () => {
  expect.assertions(2);
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
  // Outside dir holds a file over the byte cap; a followed link would refuse the clone.
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, "huge"), "");
  truncateSync(join(outside, "huge"), 51 * 1024 * 1024);
  try {
    const f = fakeRunner((repo) => {
      symlinkSync(outside, join(repo, "link"));
      symlinkSync(join(outside, "huge"), join(repo, "hugelink"));
    });
    const r = await cloneSkillSource("https://github.com/a/b", {
      tmpRoot,
      pathEnv: "/usr/bin",
      run: f.run,
    });
    expect(existsSync(r.dir)).toBe(true);
    r.cleanup();
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
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

test("ls-tree over the cap: refused before checkout, temp dir removed", async () => {
  const f = fakeRunner(() => {}, 0, `100644 blob aaa ${51 * 1024 * 1024}\tbig`);
  await expect(
    cloneSkillSource("https://github.com/a/b", { tmpRoot, pathEnv: "/usr/bin", run: f.run }),
  ).rejects.toThrow(Refused);
  expect(f.calls.some((c) => c.argv.includes("checkout"))).toBe(false);
  expect(readdirSync(tmpRoot)).toEqual([]);
});

test("ls-tree with too many entries is refused before checkout", async () => {
  const lines = Array.from({ length: 5001 }, (_, i) => `100644 blob aaa 1\tf${i}`).join("\n");
  const f = fakeRunner(() => {}, 0, lines);
  await expect(
    cloneSkillSource("https://github.com/a/b", { tmpRoot, pathEnv: "/usr/bin", run: f.run }),
  ).rejects.toThrow(Refused);
  expect(f.calls.some((c) => c.argv.includes("checkout"))).toBe(false);
});

test("clone uses --no-checkout and a low-speed limit", async () => {
  const f = fakeRunner();
  const r = await cloneSkillSource("https://github.com/a/b", {
    tmpRoot,
    pathEnv: "/usr/bin",
    run: f.run,
  });
  expect(f.calls[0]?.argv).toEqual(
    expect.arrayContaining(["--no-checkout", "http.lowSpeedLimit=1000", "http.lowSpeedTime=20"]),
  );
  r.cleanup();
});

test("parseSkillSource returns the href git must get", () => {
  expect(parseSkillSource("https://github.com/a/b").url).toBe("https://github.com/a/b");
});

test("default runner: a hung command resolves at the timeout", async () => {
  const t = Date.now();
  const r = await defaultGitRunner(["sh", "-c", "sleep 30 & sleep 30"], {}, 200);
  expect(Date.now() - t).toBeLessThan(5000);
  expect(r).toEqual({ code: -1, out: "", err: "timed out" });
});

test("default runner: output is capped at 64 KB", async () => {
  const r = await defaultGitRunner(["sh", "-c", "head -c 300000 /dev/zero | tr '\\0' x"], {}, 5000);
  expect(r.code).toBe(0);
  expect(r.out.length).toBe(64 * 1024);
});

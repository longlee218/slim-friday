import { afterAll, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isChildEnvDenied, isWorkerEnvDenied } from "../src/config/child-env-deny";
import { checkToolCall, type GuardrailContext } from "../src/policy/check-tool-call";
import { defaultEnvelope } from "../src/policy/envelope";
import { carve, workerSandbox } from "../src/runtime/worker-sandbox";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* Round-3 review fixes (H1 H2 H3 H4 M1 M3 M4 L1 L2 L3): every row is a line the reviewers used or a form the dev needs. */

const GIT = `${String.fromCharCode(46)}git`; // the git dir name (kept out of the source text)
const root = tmpRoot("round4-");
const loc = join(root, "loc");
const home = join(root, "home");
const scratch = join(home, "scratch");
const wt = join(root, "wt");
const out = join(root, "outside");
const skill = join(root, "skill");
for (const d of [join(loc, GIT), join(loc, "src"), home, scratch, wt, out, skill])
  mkdirSync(d, { recursive: true });
writeFileSync(join(out, "secret.txt"), "s");
writeFileSync(join(loc, "a.txt"), "x");
writeFileSync(join(loc, GIT, "config"), "url = https://u:tok@h/x");
symlinkSync(join(out, "secret.txt"), join(loc, "fl~")); // a file named like a rev suffix, linked outside
symlinkSync(join(loc, GIT), join(loc, "gitlnk"));

/** A worker context; `classes` picks the envelope's grant. */
const mk = (classes: string[] = ["R0", "R1"], extra: Partial<GuardrailContext> = {}) =>
  ({
    cwd: loc,
    writePaths: [loc, scratch],
    readPaths: [loc, scratch],
    denyPaths: [home],
    allowInside: [scratch, skill],
    skillDirs: [skill],
    worktreeDirs: [wt],
    shell: true,
    subagents: false,
    envelope: { ...defaultEnvelope("g", ["loc"], scratch), classes },
    ...extra,
  }) as GuardrailContext;
const decide = (command: string, ctx = mk()) => checkToolCall("Bash", { command }, ctx).decision;
const R2 = mk(["R0", "R1", "R2"]);

test("H1: a trailing ~ or ^ is stripped only on git rev operands, never when the word names a file", () => {
  expect(decide("cat fl~", R2)).toBe("deny");
  expect(decide("cat a.txt^", R2)).toBe("deny");
  expect(decide("ls fl~")).toBe("deny");
  expect(decide("git diff fl~")).toBe("deny"); // git would read the file `fl~`
  expect(decide("git add fl~")).toBe("deny"); // a path operand: never a rev
  expect(decide("git add a.txt~")).toBe("deny");
  expect(decide("git show HEAD~1")).toBe("allow");
  expect(decide("git log HEAD^")).toBe("allow");
  expect(decide("git diff HEAD~2 -- a.txt")).toBe("allow");
});

test("H2: an envelope with R2 allows listed R2 rows only; an unknown line is always denied", () => {
  for (const line of [
    "curl x",
    "python3 -c x",
    "find . -exec x",
    "env X",
    "git config a b",
    "git reset --hard",
  ])
    expect([line, decide(line, R2)]).toEqual([line, "deny"]);
  expect(decide("git reset HEAD a.txt", R2)).toBe("allow");
  expect(decide("git reset HEAD a.txt")).toBe("deny"); // no R2 grant
  expect(decide("git restore a.txt", R2)).toBe("allow");
  expect(decide("git restore a.txt")).toBe("deny");
  expect(decide("git branch -D feat/x", R2)).toBe("allow");
  expect(decide("git branch -D main", R2)).toBe("deny"); // never a default branch
  expect(decide("git branch -D release-1", R2)).toBe("deny");
  expect(decide("git branch -D a b", R2)).toBe("deny");
  const why = checkToolCall("Bash", { command: "curl x" }, R2);
  expect(why.reason).toContain("commit -m");
  expect(why.reason).toContain("worktree add");
  expect(why.reason).not.toContain("do not retry");
});

test("H2: what a dev needs works: switch to an existing branch, worktrees, messages, git show REV:path, -sb, bun test -t", () => {
  for (const line of [
    "git checkout main",
    "git switch main",
    "git switch feat/x",
    "git checkout -b feat/y main",
    `git worktree add ${wt}/feat feat/x`,
    `git worktree add -b feat/z ${wt}/z main`,
    "git worktree list",
    'git commit -m "fix: don\'t crash"',
    "git commit -m 'feat: add \"x\" flag'",
    'git commit -m "a" -m "second paragraph"',
    "git show HEAD:a.txt",
    "git show main:src/a.ts",
    "git diff main:a.txt",
    "git status -sb",
    "git branch -av",
    "bun test -t works --coverage",
    "gh pr view 12",
  ])
    expect([line, decide(line)]).toEqual([line, "allow"]);
});

test("H2: the same forms stay denied when they are unsafe", () => {
  for (const line of [
    "git checkout a.txt", // a file: git would restore it
    "git checkout -- a.txt",
    "git checkout -f main",
    "git switch --detach main",
    "git worktree add ../x feat/x", // not under the worktrees dir
    `git worktree add ${loc}/w feat/x`,
    `git worktree add ${wt}/a`,
    `git commit -m "a$(id)"`,
    'git commit -m "a`id`"',
    'git commit -m "a\\b"',
    "git commit -m 'a$b'",
    'git commit -m "it\'s!"',
    "git commit -m 'it's'",
    "git show HEAD:../outside/secret.txt",
    "git show HEAD:",
    "git show -- HEAD:a.txt:b",
    "git clean -fd",
    "git clean -d",
    "git reset --hard",
    "git fetch",
    "git pull",
    "git push origin x",
    "date +%s",
    "gh pr view https://github.com/a/b/pull/1",
    "gh pr view a/b",
    "gh pr view a:b",
  ])
    expect([line, decide(line, R2)]).toEqual([line, "deny"]);
  expect(decide("echo hello")).toBe("allow");
});

test("H3: a granted home dir is fully writable (dotfiles, git dir); a path outside every grant is still denied", () => {
  const h = homedir();
  const ctx = mk(["R0", "R1"], { cwd: h, writePaths: [h], readPaths: [h] });
  for (const f of [".zshrc", ".gitconfig", ".ssh/authorized_keys", ".config/git/config", ".npmrc"])
    expect([f, decide(`touch ${f}`, ctx)]).toEqual([f, "allow"]);
  for (const f of [".zshrc", ".gitconfig", ".ssh/id_x", ".claude/settings.json"])
    expect([
      f,
      checkToolCall("Write", { file_path: join(h, f), content: "x" }, ctx).decision,
    ]).toEqual([f, "allow"]);
  // Outside every grant (the home's parent, /etc) nothing is written.
  expect(checkToolCall("Write", { file_path: "/etc/x", content: "x" }, ctx).decision).toBe("deny");
  expect(decide("touch /etc/x", ctx)).toBe("deny");
  // The sandbox: the home is a grant, so its credential dirs are no longer denied (the location wins); the agent home stays denied.
  const fs = (workerSandbox(ctx) as { filesystem: Record<string, string[]> }).filesystem;
  expect(fs.allowWrite).toContain(h);
  expect(fs.denyWrite).toBeUndefined();
  expect(fs.denyRead).not.toContain(join(h, ".ssh"));
  expect(fs.denyRead).toContain(home);
});

test("H4: the git dir of a location is writable and readable by the shell and the file tools", () => {
  expect(decide(`touch ${GIT}/hooks/post-commit`)).toBe("allow");
  expect(decide(`cat ${GIT}/config`)).toBe("allow");
  expect(
    checkToolCall("Write", { file_path: join(loc, GIT, "hooks", "x"), content: "x" }, mk())
      .decision,
  ).toBe("allow");
});

test("M1: a skill script runs from a skill dir only, and its arguments must be flags or granted paths", () => {
  writeFileSync(join(skill, "run.sh"), "x");
  writeFileSync(join(scratch, "own.sh"), "x");
  expect(decide(`${skill}/run.sh a.txt`)).toBe("allow");
  expect(decide(`bash ${skill}/run.sh --fast a.txt`)).toBe("allow");
  expect(decide(`bash ${skill}/run.sh /etc/passwd`)).toBe("deny");
  expect(decide(`bash ${skill}/run.sh ${out}/secret.txt`)).toBe("deny");
  expect(decide(`bash ${skill}/run.sh --out=/etc/x`)).toBe("deny");
  expect(decide(`bash ${skill}/run.sh ../x`)).toBe("deny");
  expect(decide(`bash ${scratch}/own.sh`)).toBe("deny"); // allowInside but not a skill dir, and writable
  expect(decide(`bash ${skill}/run.sh a.txt`, mk(["R0", "R1"], { skillDirs: [] }))).toBe("deny");
});

test("M3: reads are deny-by-default for the home; a granted home is listed child by child without its credential dirs", () => {
  const fake = join(root, "fakehome");
  for (const d of [".ssh", ".aws", "proj", ".config/gh", ".config/other"])
    mkdirSync(join(fake, d), { recursive: true });
  writeFileSync(join(fake, "notes.txt"), "x");
  const allowed = carve(fake, [
    join(fake, ".ssh"),
    join(fake, ".aws"),
    join(fake, ".config", "gh"),
  ]);
  expect(allowed).toEqual(
    expect.arrayContaining([
      join(fake, "proj"),
      join(fake, "notes.txt"),
      join(fake, ".config", "other"),
    ]),
  );
  for (const bad of [".ssh", ".aws", ".config/gh", ".config"])
    expect(allowed).not.toContain(join(fake, bad));
  expect(carve(loc, [join(out, "x")])).toEqual([loc]);
  const sb = (workerSandbox(mk()) as { filesystem: { denyRead: string[]; allowRead: string[] } })
    .filesystem;
  // A credential dir no grant covers stays denied.
  expect(sb.denyRead).toEqual(
    expect.arrayContaining([homedir(), join(homedir(), ".ssh"), join(homedir(), ".claude")]),
  );
  if (process.platform === "darwin") expect(sb.denyRead).toContain("/Users");
  expect(sb.allowRead).toContain(loc);
  expect(sb.allowRead).toContain(skill);
  expect(sb.allowRead).not.toContain(homedir());
});

test("M4: file tools of a worker read inside a git dir of its location (name, case, symlink, glob)", () => {
  const call = (name: string, input: Record<string, unknown>) =>
    checkToolCall(name, input, mk()).decision;
  expect(call("Read", { file_path: join(loc, GIT, "config") })).toBe("allow");
  expect(call("Read", { file_path: join(loc, GIT.toUpperCase(), "config") })).toBe("allow");
  expect(call("Read", { file_path: join(loc, "gitlnk", "config") })).toBe("allow");
  expect(call("Grep", { pattern: "url", path: join(loc, GIT) })).toBe("allow");
  expect(call("Glob", { pattern: `**/${GIT}/config`, path: loc })).toBe("allow");
  expect(call("Read", { file_path: join(out, "secret.txt") })).toBe("deny"); // outside every grant
});

test("L3: more secret-looking env names are dropped for a worker", () => {
  for (const k of [
    "DB_PWD",
    "STRIPE_APIKEY",
    "GH_AUTHTOKEN",
    "SENTRY_DSN",
    "DATABASE_URL",
    "PG_CONNECTION_STRING",
    "MY_PASSWORD",
  ])
    expect([k, isWorkerEnvDenied(k)]).toEqual([k, true]);
  expect(isWorkerEnvDenied("PWD")).toBe(isChildEnvDenied("PWD")); // the shell's own cwd stays
  expect(isWorkerEnvDenied("OLDPWD")).toBe(false);
});

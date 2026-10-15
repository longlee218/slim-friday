import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext } from "../src/guardrails/check-tool-call";
import { classifyBash } from "../src/orchestrator/approval/bash-allowlist";
import { defaultEnvelope } from "../src/orchestrator/approval/envelope";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* The worker shell gate is DEFAULT DENY BY SHAPE (shell-shape.ts + shell-table.ts): one simple command of plain words, every flag
   listed, every path operand inside the granted dirs. Table driven: LEGIT rows must pass, HOSTILE rows must be denied (round-2 and
   round-3 review lines), and the whole recorded corpus (test/fixtures/worker-shell-lines.txt) is denied except the legit set. */

const GIT = `${String.fromCharCode(46)}git`; // the git dir name (kept out of the source text)
const root = tmpRoot("shell-shape-");
const loc = join(root, "loc");
const home = join(root, "home");
const scratch = join(home, "scratch");
const other = join(root, "other");
for (const d of [
  join(loc, GIT, "hooks"),
  join(loc, "src"),
  join(loc, "sub", GIT),
  home,
  scratch,
  other,
])
  mkdirSync(d, { recursive: true });
writeFileSync(join(other, "secret.txt"), "x");
symlinkSync(other, join(loc, "lnk"));

const ctx: GuardrailContext = {
  cwd: loc,
  writePaths: [loc, scratch],
  readPaths: [loc, scratch],
  denyPaths: [home],
  allowInside: [scratch],
  worktreeDirs: [join(root, "wt")],
  shell: true,
  subagents: false,
  envelope: defaultEnvelope("g", ["loc"], scratch),
};
/** Decision of the full guard (deny list first, then the shape gate) for one line. */
const decide = (line: string) =>
  checkToolCall(
    "Bash",
    { command: line.replaceAll("@OTHER", other).replaceAll("@LOC", loc).replaceAll("@G", GIT) },
    ctx,
  ).decision;

/** Real dev flows: they must keep passing. */
const LEGIT = [
  // A location is trusted: its git dir is an ordinary part of it for the shell.
  "cat @G/config",
  "ls @G",
  "touch @G/hooks/pre-commit",
  "cp a @G/config",
  "git add @G/config",
  "bun test",
  "bun test test/worker-shell-shape.test.ts",
  "bun run lint",
  "bun run format",
  "bunx tsc --noEmit",
  "git status",
  "git diff",
  "git diff --stat HEAD~1",
  "git log --oneline -20",
  "git log --oneline --graph -n 5",
  "git show HEAD --stat",
  "git branch -a",
  "git rev-parse --show-toplevel",
  "rg -n foo src",
  "rg --files src",
  "rg -n -t ts foo src",
  "ls src/orchestrator",
  "ls -la",
  "cat src/a.ts",
  "head -n 20 src/a.ts",
  "sed -n 1,20p src/a.ts",
  "find src -name a.ts -type f",
  "git add src/x.ts",
  "git add -A",
  'git commit -m "feat: x"',
  "git commit -m 'fix: handle a (b); c'",
  "git commit -m plain",
  "git checkout -b feat/new-thing",
  "git switch -c feat/other",
  "git stash push",
  "git stash list",
  "mkdir -p src/new/dir",
  "touch src/new.ts",
  "cp src/a.ts src/b.ts",
  "tsc --noEmit -p .",
  "biome check src",
  "pytest -q -x",
  "go test ./...",
  "npm run build",
  "pwd",
  "gh pr view 12",
  "gh pr checks 12",
  "gh pr list --state open --limit 5",
];

/** Round-2 / round-3 hostile lines. */
const HOSTILE = [
  // value-flag swallowing: a flag that takes no value must not hide the next flag
  "git log -m --output=x",
  "git log -m --output x",
  "git diff -m --no-index /etc/passwd x",
  "git fetch -t --upload-pack=sh",
  "git log --max-count --output=x",
  "head -n --output=x a",
  "rg -m --pre sh x",
  // redirects, including descriptor duplication and here-docs
  "ls >&1d/../@G/config",
  "ls >&2",
  "ls 2>&1",
  "cat < /etc/hosts",
  "cat <<EOF",
  "echo hi > out.txt",
  "ls &> out",
  // globs, braces, expansions, quotes, escapes
  "cat src/*",
  "cat s?c/a.ts",
  "cat [a-z]*",
  "touch src/*.ts",
  "cp a *.ts",
  "ls ..{,}",
  "ls {a,b}",
  "ls /e{tc}",
  "echo $GH_TOKEN",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell line
  "echo ${GH_TOKEN}",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell line
  "ls ${HOME}",
  "ls $HOME",
  "ls $'abc'",
  "ls ~root",
  "ls ~",
  "cat ~/.ssh/id_rsa",
  "ls \\\n..",
  "ls src\\\n/..",
  'ls "src"',
  "ls 'src'",
  "echo `id`",
  "echo $(id)",
  "r\\m -rf x",
  "ls !!",
  "ls #x",
  // abbreviated or attached flags
  "git log --out=x",
  "git log --oneli",
  "git diff --stat=200",
  "head -n5 a",
  "sort -ou a",
  "cp -t.git/hooks a",
  "cp -t@G/hooks a",
  "cp -vt/etc a",
  "cp -t /etc a",
  "cp --target-directory=src a",
  "mkdir -m777 x",
  "mkdir --mode=777 x",
  "touch -r /etc/hosts x",
  // git verbs outside the list
  "git fetch origin",
  "git pull",
  "git checkout *",
  "git checkout -- .",
  "git checkout -b",
  "git checkout -B x",
  "git switch -m x",
  "git switch -c",
  "git branch -m evil",
  "git branch -c a b",
  "git branch -d x",
  "git branch newone",
  "git restore .",
  "git reset --hard",
  "git clean -fd",
  "git worktree add ../x",
  "git config user.name x",
  "git remote add x y",
  "git remote set-url origin x",
  "git tag v1",
  "git tag -d v1",
  "git tag -F /etc/hosts v",
  "git commit -F /etc/hosts",
  "git commit --file=/etc/hosts",
  "git commit -m",
  'git commit -m "a$(id)"',
  'git commit -m "a`id`"',
  'git commit -m "a\\"b"',
  'git commit -m "a" ; ls',
  "git -C .. status",
  "git -c core.pager=x log",
  "git --git-dir=x log",
  "git --no-pager log",
  "git push origin feat",
  "git merge feat",
  "git stash drop",
  "git stash apply",
  "git diff --output=x",
  "git diff -O x",
  "git log -fo",
  // paths
  "cat ../x",
  "cat src/../../x",
  "cat lnk/secret.txt",
  "cat @OTHER/secret.txt",
  "cat /etc/hosts",
  "cat /tmp/x",
  "touch /tmp/x",
  "mkdir /private/tmp/x",
  "cp a src/../@G/hooks/x",
  "git diff -- /etc/hosts",
  // commands outside the table, hangs and pagers
  "tail -f src/a.ts",
  "tail -F src/a.ts",
  "less src/a.ts",
  "more src/a.ts",
  "man ls",
  "watch ls",
  "cd src",
  "cd ..",
  "env ls",
  "xargs ls",
  "sh -c ls",
  "bash src/a.sh",
  "./run.sh",
  "node x.js",
  "python3 -c 1",
  "curl x",
  "eval ls",
  "sudo ls",
  "rm -rf node_modules",
  "bun run ./x.ts",
  "bun run a;b",
  "bun add x",
  "bun install",
  "npm install",
  "bunx something",
  "gh pr view -R other/repo",
  "gh pr view --repo other/repo",
  "gh pr checks --watch",
  "gh pr create --fill",
  "gh api repos/x",
  "gh auth status -t",
  "ls; ls",
  "ls && ls",
  "ls | ls",
  "ls || ls",
  "ls & ls",
  "ls\nls",
  "ls\tsrc",
  "(ls)",
  "FOO=1 ls",
  "ls FOO=1",
  "ls ＿",
  "ｌｓ",
];

/** Lines of the recorded corpus that are real dev flows: every other line of the file must be denied. */
const CORPUS_ALLOWED = new Set(LEGIT);

test("legit dev flows pass the shape gate", () => {
  for (const line of LEGIT) expect([line, decide(line)]).toEqual([line, "allow"]);
});

for (const line of HOSTILE)
  test(`denied: ${JSON.stringify(line)}`, () => {
    expect(decide(line)).toBe("deny");
    // The shape gate alone (without the deny list in front of it) already refuses: nothing here is R0 / R1.
    const real = line.replaceAll("@OTHER", other).replaceAll("@G", GIT);
    expect(["R0", "R1"]).not.toContain(classifyBash(real, ctx).risk);
  });

test("recorded corpus: every line is denied unless it is a legit dev flow", async () => {
  const lines = (await Bun.file(join(import.meta.dir, "fixtures", "worker-shell-lines.txt")).text())
    .split("\n")
    .filter(Boolean);
  expect(lines.length).toBeGreaterThan(300);
  // A git dir of the location is an ordinary dir for the shell (the owner trusts a location): those lines are allowed on purpose.
  const gitDirLine = /(^|[ /])(@G|\.git)(\/|$)/i;
  const allowed = lines.filter(
    (l) => decide(l) === "allow" && !CORPUS_ALLOWED.has(l) && !gitDirLine.test(l),
  );
  // These are plain legit forms of the same grammar, each one reviewed (no path, flag or value escapes the table).
  const reviewed = new Set(
    "bun run x|bun test|cat /dev/null|cp a /dev/null|find . -name x -print|gh pr list --json x|gh pr view|gh pr view --json x|git add .|git checkout -b x|git commit --amend --no-edit|git commit -a -m x|git commit -m x|git diff --cached|git diff --check|git diff --name-only|git diff --stat|git diff -w|git diff HEAD~1 -- a|git log --all|git log --graph --oneline|git log -p|git log -S x|git ls-files --others|git ls-files -z|git remote|git remote --verbose|git remote -v|git rev-parse --git-dir|git rev-parse HEAD|git show --pretty=format:%H|git show --stat|git stash pop|git status --ignored|git status --porcelain|git status --untracked-files=all|git status -s|git switch -c x|ls -- --x|ls -la|npm run x|git stash list|git status|git add -A|git checkout main|git checkout HEAD~1|git checkout origin/main|git clean -n|git show HEAD:a|git status -sb|git switch main|git worktree list".split(
      "|",
    ),
  );
  expect(allowed.filter((l) => !reviewed.has(l))).toEqual([]);
});

test("hostile table size: at least 60 new rows", () => {
  expect(HOSTILE.length).toBeGreaterThanOrEqual(60);
});

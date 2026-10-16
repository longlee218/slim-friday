import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { isWorkerEnvDenied } from "../src/config/child-env-deny";
import { GIT_HARDEN } from "../src/locations/git-cli";
import { GIT_ISOLATED_ENV } from "../src/locations/git-isolation";
import { hardenedArgv, subprocessEnv } from "../src/locations/git-run";
import { checkToolCall, type GuardrailContext, guardFor } from "../src/policy/check-tool-call";
import { defaultEnvelope } from "../src/policy/envelope";
import { getRole } from "../src/roles/role-registry";
import { runAgent } from "../src/runtime/run-agent";
import { SANDBOX_UNAVAILABLE, SandboxUnavailableError } from "../src/runtime/sandbox-errors";
import { sdkEnv } from "../src/runtime/sdk-env";
import { workerSandbox } from "../src/runtime/worker-sandbox";
import { makeEnv, resultMsg } from "./helpers";
import { leadHarness, until } from "./lead-harness";
import { cleanupTmp, tmpRoot } from "./tmp-dirs";

afterAll(cleanupTmp);

/* Round-3 hardening of the worker: scrubbed env, closed sandbox, no auto-approval, a coded failure when
   the sandbox cannot start, file tools limited to the granted dirs, hardened app git calls. Options are read from a fake query. */

const GIT = `${String.fromCharCode(46)}git`; // the git dir name
const SECRETS: Record<string, string> = {
  GH_TOKEN: "x",
  GITHUB_TOKEN: "x",
  GITHUB_PERSONAL_ACCESS_TOKEN: "x",
  AWS_ACCESS_KEY_ID: "x",
  AWS_SECRET_ACCESS_KEY: "x",
  AWS_PROFILE: "x",
  OPENROUTER_API_KEY: "x",
  ANTHROPIC_API_KEY: "x",
  DISCORD_TOKEN: "x",
  NPM_TOKEN: "x",
  STRIPE_SECRET: "x",
  DB_PASSWORD: "x",
  MY_API_KEY: "x",
  SSH_AUTH_SOCK: "x",
  GIT_SSH_COMMAND: "x",
  GIT_EXTERNAL_DIFF: "x",
  CLAUDE_CODE_OAUTH_TOKEN: "owner-oauth",
};

test("worker env: no token, key, secret, password, cloud or git auth; identity, PATH and the scrub switch stay", () => {
  const { config } = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" });
  const source = { ...SECRETS, PATH: "/bin", HOME: "/h", GIT_AUTHOR_NAME: "me", LANG: "C" };
  const env = sdkEnv(config, source, undefined, { worker: true });
  for (const k of Object.keys(SECRETS).filter((k) => k !== "CLAUDE_CODE_OAUTH_TOKEN"))
    expect([k, k in env]).toEqual([k, false]);
  expect(env).toMatchObject({ PATH: "/bin", HOME: "/h", GIT_AUTHOR_NAME: "me", LANG: "C" });
  // The model call still has its credential (the SDK strips it from the tools' env with this switch).
  expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-test");
  // Not a worker: the owner's env passes through as before.
  expect(sdkEnv(config, source).GH_TOKEN).toBe("x");
  for (const k of ["MY_API_KEY", "X_SECRET", "db_password", "A_CREDENTIALS_B", "AWS_REGION"])
    expect([k, isWorkerEnvDenied(k)]).toEqual([k, true]);
  for (const k of ["PATH", "HOME", "KEYBOARD", "MONKEY", "TERM"])
    expect([k, isWorkerEnvDenied(k)]).toEqual([k, false]);
});

const root = tmpRoot("round3-");
const loc = join(root, "loc");
const home = join(root, "home");
const scratch = join(home, "scratch");
const wt = join(root, "wt");
for (const d of [join(loc, GIT), join(loc, "sub", "inner", GIT), join(wt, "feat"), scratch])
  mkdirSync(d, { recursive: true });
writeFileSync(join(wt, "feat", GIT), "gitdir: x"); // the gitfile of a worktree
const ctx: GuardrailContext = {
  cwd: loc,
  writePaths: [loc, scratch],
  readPaths: [loc, scratch],
  denyPaths: [home],
  allowInside: [scratch],
  worktreeDirs: [wt],
  shell: true,
  subagents: false,
  envelope: defaultEnvelope("g", ["loc"], scratch),
};

test("sandbox: network closed (strictAllowlist), writes only in the grants (no per-path denyWrite), credential dirs outside the grants unreadable", () => {
  const sb = workerSandbox(ctx) as { network: any; filesystem: any };
  expect(sb.network).toEqual({ allowedDomains: [], strictAllowlist: true });
  expect(sb.filesystem.allowWrite).toEqual(expect.arrayContaining([loc, scratch, wt]));
  expect(sb.filesystem.denyWrite).toBeUndefined(); // inside a grant the worker writes everything, `.git` included
  expect(sb.filesystem.denyRead).toEqual(
    expect.arrayContaining([home, join(homedir(), ".ssh"), join(homedir(), ".aws")]),
  );
});

test("sandbox: a run with no write grant covering its cwd (the scout) gets an explicit denyWrite on the cwd", () => {
  const sb = workerSandbox({ ...ctx, cwd: loc, writePaths: [], worktreeDirs: [] }) as {
    filesystem: any;
  };
  expect(sb.filesystem.denyWrite).toEqual([realpathSync(loc)]);
  const dev = workerSandbox({ ...ctx, cwd: loc, writePaths: [loc] }) as { filesystem: any };
  expect(dev.filesystem.denyWrite).toBeUndefined();
});

/** One worker run over a fake query: the options it passed and what it threw. */
async function workerRun(thrown?: Error) {
  const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" });
  let options: Options | undefined;
  const queryFn = (a: { options?: Options }) =>
    (async function* () {
      options = a.options;
      if (thrown) throw thrown;
      yield resultMsg({ result: "ok" });
    })();
  const role = getRole("developer");
  const run = runAgent({
    prompt: "q",
    turnId: "t1",
    cwd: env.home,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    queryFn: queryFn as never,
    role,
    guard: guardFor(role, { ...ctx, cwd: env.home, writePaths: [env.location] }),
    code: { threadId: "th", gateway: undefined },
  });
  return { run, options: () => options };
}

test("worker options: default permission mode (nothing auto-approved), scrubbed env, closed sandbox with no opt-out", async () => {
  for (const [k, v] of Object.entries(SECRETS)) process.env[k] = v;
  try {
    const { run, options } = await workerRun();
    await run;
    const o = options() as Options & { env: Record<string, string> };
    expect(o.permissionMode).toBe("default");
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(o.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [], strictAllowlist: true },
    });
    for (const k of Object.keys(SECRETS).filter((k) => k !== "CLAUDE_CODE_OAUTH_TOKEN"))
      expect([k, k in o.env]).toEqual([k, false]);
    expect(o.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
  } finally {
    for (const k of Object.keys(SECRETS)) delete process.env[k];
  }
});

test("a sandbox that cannot start fails the run with SANDBOX_UNAVAILABLE (thrown error or result error), never a silent success", async () => {
  const thrown = await workerRun(
    new Error("Sandbox required but unavailable: bubblewrap (bwrap) not found"),
  );
  const err = await thrown.run.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SandboxUnavailableError);
  expect((err as SandboxUnavailableError).code).toBe(SANDBOX_UNAVAILABLE);
  expect((err as Error).message).toStartWith(SANDBOX_UNAVAILABLE);
  // An ordinary failure is not mistaken for it.
  const other = await (await workerRun(new Error("network down"))).run.catch((e: unknown) => e);
  expect(other).not.toBeInstanceOf(SandboxUnavailableError);
});

test("the lead hears a `failure` event naming SANDBOX_UNAVAILABLE; the worker is not retried", async () => {
  let announced = "";
  const h = leadHarness(async (c) => {
    if (c.kind === "worker") throw new Error("sandbox-exec: sandbox could not be started");
    if (c.prompt.includes("Owner message:")) {
      await c.tool("DispatchAgent", {
        strategy: "DIRECT",
        intent: "x",
        reason: "r",
        assignments: [
          { key: "a", role: "developer", brief: "do a", location: "location", dependsOn: [] },
        ],
      });
      return "started";
    }
    announced = c.prompt;
    return "told";
  });
  await h.send("do a");
  await until(() => announced.includes("failure"), 8000);
  expect(announced).toContain(SANDBOX_UNAVAILABLE);
  await Bun.sleep(150);
  expect(h.ofKind("worker")).toHaveLength(1); // no retry loop
});

test("file tools: a worker reads only the granted dirs and writes a git dir inside its location; symlinks and relative escapes resolve", () => {
  mkdirSync(join(root, "other"), { recursive: true });
  symlinkSync(join(root, "other"), join(loc, "lnk"));
  const call = (tool: string, input: Record<string, unknown>) =>
    checkToolCall(tool, input, ctx).decision;
  expect(call("Read", { file_path: join(loc, "a.ts") })).toBe("allow");
  expect(call("Read", { file_path: join(scratch, "n.md") })).toBe("allow");
  for (const p of [".ssh/id_rsa", ".config/gh/hosts.yml", ".aws/credentials", ".zsh_history"])
    expect([p, call("Read", { file_path: join(homedir(), p) })]).toEqual([p, "deny"]);
  expect(call("Grep", { pattern: "x", path: join(homedir(), ".ssh") })).toBe("deny");
  expect(call("Glob", { pattern: "*", path: "/etc" })).toBe("deny");
  expect(call("Read", { file_path: "lnk/secret.txt" })).toBe("deny"); // a symlink out of the location
  expect(call("Read", { file_path: "../other/x" })).toBe("deny");
  for (const f of ["info/exclude", "HEAD", "hooks/pre-commit", "config", "refs/heads/x"])
    expect([f, call("Write", { file_path: join(loc, GIT, f), content: "x" })]).toEqual([
      f,
      "allow",
    ]);
  expect(call("Write", { file_path: join(loc, "sub", "inner", GIT, "config"), content: "x" })).toBe(
    "allow",
  );
  expect(call("Write", { file_path: join(scratch, "..", "..", "x"), content: "x" })).toBe("deny"); // outside every grant
  expect(call("Write", { file_path: join(loc, "ok.ts"), content: "x" })).toBe("allow");
});

test("app git calls: hardening options and a scrubbed env (no GIT_* but the identity); gh keeps its own token", () => {
  const argv = hardenedArgv(["git", "status"]);
  expect(argv.slice(0, 1 + GIT_HARDEN.length)).toEqual(["git", ...GIT_HARDEN]);
  expect(argv.at(-1)).toBe("status");
  // The owner's global and system git config are off; the credential helpers are explicit.
  expect(argv).toContain("credential.helper=");
  expect(argv).toContain("credential.https://github.com.helper=!gh auth git-credential");
  expect(GIT_HARDEN).toEqual(
    expect.arrayContaining([
      "core.hooksPath=/dev/null",
      "core.fsmonitor=false",
      "core.pager=cat",
      "core.sshCommand=ssh",
      "core.editor=true",
      "core.askPass=",
      "diff.external=",
      "protocol.ext.allow=never",
    ]),
  );
  expect(hardenedArgv(["gh", "pr", "create"])).toEqual(["gh", "pr", "create"]);
  const source = {
    GIT_SSH_COMMAND: "x",
    GIT_DIR: "y",
    GIT_AUTHOR_NAME: "me",
    GH_TOKEN: "t",
    PATH: "/bin",
  };
  expect(subprocessEnv(["git", "push"], source)).toEqual({
    GIT_AUTHOR_NAME: "me",
    GH_TOKEN: "t",
    PATH: "/bin",
    ...GIT_ISOLATED_ENV,
  });
  expect(subprocessEnv(["gh", "pr", "create"], source)).toEqual(source);
});

test("sandbox: a write grant that contains the agent home (a $HOME location) gets denyWrite on the agent home, around the run's own dirs", () => {
  const root = realpathSync(tmpRoot("sbx-home-"));
  const agentHome = join(root, ".friday");
  const own = join(agentHome, "goals", "g1");
  mkdirSync(own, { recursive: true });
  mkdirSync(join(agentHome, "db"), { recursive: true });
  const sb = workerSandbox({
    cwd: root,
    writePaths: [root],
    readPaths: [root],
    denyPaths: [agentHome],
    envelope: defaultEnvelope("g", ["loc"], own),
  } as never) as { filesystem: { denyWrite?: string[] } };
  expect(sb.filesystem.denyWrite).toContain(join(agentHome, "db"));
  expect(sb.filesystem.denyWrite).not.toContain(agentHome);
  expect(sb.filesystem.denyWrite).not.toContain(own);
});

test("sandbox: sensitive files of a grant (.env, keys/, credentials/) are denied read and write, skipped dirs are not searched", () => {
  const root = tmpRoot("sbx-sens-");
  mkdirSync(join(root, "keys"));
  mkdirSync(join(root, "app", "node_modules"), { recursive: true });
  writeFileSync(join(root, ".env"), "X=1");
  writeFileSync(join(root, "app", ".env.local"), "X=1");
  writeFileSync(join(root, "app", "node_modules", ".env"), "X=1");
  writeFileSync(join(root, "README.md"), "x");
  const sb = workerSandbox({
    cwd: root,
    writePaths: [root],
    readPaths: [root],
    envelope: defaultEnvelope("g", ["loc"], root),
  } as never) as {
    filesystem: {
      denyRead: string[];
      denyWrite: string[];
      allowWrite: string[];
      allowRead: string[];
    };
  };
  const f = sb.filesystem;
  for (const p of [join(root, ".env"), join(root, "app", ".env.local"), join(root, "keys")]) {
    expect(f.denyRead).toContain(p);
    expect(f.denyWrite).toContain(p);
    expect(f.allowWrite).not.toContain(p);
  }
  expect(f.denyRead).not.toContain(join(root, "app", "node_modules", ".env"));
  expect(f.allowRead).toContain(join(root, "README.md"));
  expect(f.allowWrite).not.toContain(root);
});

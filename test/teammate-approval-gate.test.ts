import { expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { workspacePaths } from "../src/config/workspace-paths";
import { GIT_PUSH_TOOL } from "../src/mcp/effects/tools/GitPushTool/constants";
import { teammateEffectsCtx } from "../src/orchestrator/teammate/teammate-effects-ctx";
import { guardFor } from "../src/policy/check-tool-call";
import type { Runner } from "../src/policy/effect-context";
import { getRole } from "../src/roles/role-registry";
import type { RoleDefinition } from "../src/roles/role-types";
import { runAgent } from "../src/runtime/run-agent";
import { makeEnv, resultMsg, stubGateway } from "./helpers";
import { toolOf } from "./mcp-run-probe";

/* THE GATE of the teammate store (phase 04 starts only when this is green): a teammate-kind run that holds a shell and an
   effect tool is protected in EVERY SDK permission mode, because the protection is derived from its tools and the owner's
   question is asked by the tool handler itself, not by the SDK guard (which `auto` and `bypassPermissions` skip). */

const SIG = { signal: new AbortController().signal };
const MODES = ["auto", "bypassPermissions", "default"] as const;

/** A teammate with a shell and GitPush: the strongest tool set a teammate can be given. */
const roleIn = (permissionMode: (typeof MODES)[number]): RoleDefinition => ({
  ...getRole("chief-of-staff"),
  permissionMode: permissionMode === "default" ? undefined : permissionMode,
  capabilities: ["read", "shell"],
  mcpTools: [GIT_PUSH_TOOL],
});

/** A git runner that answers the push's preconditions and records every command it was given. */
function fakeGit(): { run: Runner; seen: string[] } {
  const seen: string[] = [];
  const run: Runner = async (cmd) => {
    const line = cmd.join(" ");
    seen.push(line);
    if (line === "git remote") return { code: 0, out: "origin\n" };
    if (line.startsWith("git remote get-url")) return { code: 0, out: "https://example.com/r.git" };
    if (line.startsWith("git rev-parse")) return { code: 0, out: "abc" };
    if (line.startsWith("git ls-remote")) return { code: 0, out: "ref: refs/heads/main\tHEAD" };
    return { code: 0, out: "" };
  };
  return { run, seen };
}

/** Run the role once; the fake `query` hands the options to `probe` while the run is open. */
async function runWith(
  mode: (typeof MODES)[number],
  answer: boolean,
  probe: (o: Options, git: ReturnType<typeof fakeGit>) => Promise<void>,
) {
  const env = makeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" }); // a real login: `auto` is available
  const loc = realpathSync(env.location);
  const role = roleIn(mode);
  const turnId = `gate-${mode}`;
  const scratch = workspacePaths(env.home).run(turnId);
  mkdirSync(scratch, { recursive: true });
  const asked: string[] = [];
  const git = fakeGit();
  const approvals = stubGateway({
    confirm: async (r) => {
      asked.push(r.summary);
      return { approved: answer };
    },
  });
  await runAgent({
    role,
    prompt: "q",
    turnId,
    cwd: loc,
    config: env.config,
    db: env.db,
    abortController: new AbortController(),
    guard: guardFor(role, {
      cwd: loc,
      readPaths: [loc, realpathSync(scratch)],
      denyPaths: [realpathSync(env.home)],
      allowInside: [realpathSync(scratch)],
      scratchDir: realpathSync(scratch),
    }),
    code: { threadId: "th", gateway: approvals },
    appCtx: () => ({
      effects: {
        ...teammateEffectsCtx({
          db: env.db,
          approvals,
          agentHome: env.home,
          threadId: "th",
          turnId,
          language: "en",
          scratchDir: realpathSync(scratch),
          locations: [{ name: "location", path: loc }],
        }),
        run: git.run,
      },
    }),
    queryFn: ((a: { options?: Options }) =>
      (async function* () {
        await probe(a.options as Options, git);
        yield resultMsg({ result: "ok" });
      })()) as never,
  });
  return { asked, git };
}

const push = (o: Options) =>
  toolOf(o, GIT_PUSH_TOOL)!.handler(
    { location: "location", remote: "origin", branch: "feat/x" },
    {},
  );

for (const mode of MODES) {
  test(`gate (${mode}): a GitPush asks the owner exactly once; a yes runs it`, async () => {
    let reply: any;
    const { asked, git } = await runWith(mode, true, async (o) => {
      reply = JSON.parse((await push(o)).content[0].text);
    });
    expect(asked).toHaveLength(1);
    expect(reply.ok).toBe(true);
    expect(git.seen.some((c) => c.startsWith("git push"))).toBe(true);
  });

  test(`gate (${mode}): a no refuses the push and git never sees it`, async () => {
    let reply: any;
    const { asked, git } = await runWith(mode, false, async (o) => {
      reply = JSON.parse((await push(o)).content[0].text);
    });
    expect(asked).toHaveLength(1);
    expect(reply.ok).toBe(false);
    expect(reply.code).toBe("OWNER_DENIED");
    expect(git.seen.some((c) => c.startsWith("git push"))).toBe(false);
  });

  test(`gate (${mode}): the shell runs in the OS sandbox and a Read outside the grants is denied`, async () => {
    let options: Options | undefined;
    let verdict: any;
    await runWith(mode, true, async (o) => {
      options = o;
      verdict = await o.hooks!.PreToolUse![0]!.hooks[0]!(
        {
          hook_event_name: "PreToolUse",
          tool_use_id: "u1",
          tool_name: "Read",
          tool_input: { file_path: "/etc/hosts" },
        } as never,
        "u1",
        SIG,
      );
    });
    expect(options?.sandbox).toMatchObject({ enabled: true, failIfUnavailable: true });
    expect(verdict.hookSpecificOutput.permissionDecision).toBe("deny");
    // A protected run is never left to a classifier or to bypass.
    expect(options?.permissionMode).toBe("default");
    expect(options?.allowDangerouslySkipPermissions).toBeUndefined();
  });
}

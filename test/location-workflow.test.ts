import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSkillsLock } from "../src/config/skills-lock";
import { createTurnHandler } from "../src/orchestrator/handle-message";
import { setupWorkflow } from "./code-flow-fixture";
import { devIntent, initMsg, resultMsg, stubGateway, TEST_CHANNEL } from "./helpers";

/** Skills the dev role gets: every installed publisher skill, as the lock lists them (no names here). */
const SP = Object.entries(readSkillsLock()).map(([k, e]) => `${e.source.split("/").pop()}:${k}`);
/** The skills of a dev run as sorted names: the installed ones plus the given workspace ones. */
const withSet = (...ws: string[]) => [...SP, ...ws].sort();

/** Run a dev task to its end; return the options of its (one) run. */
async function runTask(
  config: Record<string, string>,
  skills: string[],
  prep?: (clone: string) => void,
  locationSkills: string[] = [],
  /** Called with the options of the run while it is alive (plugin dirs exist), e.g. to probe canUseTool. */
  probe?: (o: any) => Promise<void>,
) {
  const { env, clone } = await setupWorkflow(config, skills, locationSkills);
  prep?.(clone);
  const seen: any[] = [];
  /** Plugin dir listing at run start (the app removes the dir when the run ends). */
  let pluginFiles: string[] = [];
  const next = (a: any) => {
    seen.push(a.options);
    const pdir = a.options.plugins?.at(-1)?.path; // the workspace plugin is built last
    if (pdir) pluginFiles = (readdirSync(pdir, { recursive: true }) as string[]).sort();
    return (async function* () {
      yield initMsg;
      await probe?.(a.options);
      yield resultMsg({ result: "done\n\nlocation: real" });
    })();
  };
  const handle = createTurnHandler({
    db: env.db,
    config: env.config,
    approvals: stubGateway({ confirm: async () => ({ approved: false, reason: "no" }) }),
    queryFn: next as never,
    intent: devIntent(env.home),
  });
  await handle({
    source: "t",
    channelId: TEST_CHANNEL,
    userId: "u",
    threadId: "th1",
    text: "[dev] change it",
  });
  expect(seen).toHaveLength(1); // one run
  return { env, clone, exec: seen[0], pluginFiles };
}

test("workspace skills load in the dev run; no workflow mode rules", async () => {
  const { exec } = await runTask({}, ["deploy"]);
  expect([...exec.skills].sort()).toEqual(withSet("main:deploy"));
  expect(exec.settingSources).toEqual([]);
  expect(exec.systemPrompt.append).not.toContain("workflow: full");
  expect(exec.systemPrompt.append).toContain("At most 6"); // the ask boundary applies to every code task
});

test("no location CLAUDE.md reaches the dev prompt, and the registry has no read hint", async () => {
  const { exec } = await runTask({}, [], (clone) =>
    writeFileSync(join(clone, "CLAUDE.md"), "CLAUDE_BODY_MARK"),
  );
  expect(exec.systemPrompt.append).not.toContain("CLAUDE_BODY_MARK");
  expect(exec.systemPrompt.append).not.toContain("CLAUDE.md");
  expect(exec.settingSources).toEqual([]);
});

test("location .claude/skills (clone and worktree) plus hooks never contribute to the dev run", async () => {
  const { exec, pluginFiles } = await runTask(
    {},
    ["deploy"],
    (clone) => {
      // Untracked decoys in the clone: skills, hooks and an mcp file.
      const d = join(clone, ".claude", "skills", "clone-only");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "SKILL.md"), "---\nname: clone-only\ndescription: d\n---\nx\n");
      mkdirSync(join(clone, ".claude", "hooks"), { recursive: true });
      writeFileSync(join(clone, ".claude", "hooks", "hooks.json"), '{"hooks":{}}');
    },
    ["tracked"],
  );
  expect([...exec.skills].sort()).toEqual(withSet("main:deploy"));
  expect(pluginFiles.some((f) => /clone-only|tracked|hooks/.test(f))).toBe(false);
});

test("the dev run lists the workspace skills through an app-owned plugin copy, not the location", async () => {
  const { clone, exec, pluginFiles } = await runTask({}, ["deploy", "review"]);
  const pdir: string = exec.plugins.at(-1).path; // set plugin first, workspace plugin last
  expect(exec.plugins).toHaveLength(2);
  expect(exec.skills.sort()).toEqual(withSet("main:deploy", "main:review")); // workspace name = plugin name
  // Not the location's .claude: the plugin dir is the app's own copy.
  expect(pdir.startsWith(realpathSync(clone))).toBe(false);
  expect(pluginFiles).toEqual(
    [
      ".claude-plugin",
      ".claude-plugin/plugin.json",
      "skills",
      "skills/deploy",
      "skills/deploy/SKILL.md",
      "skills/review",
      "skills/review/SKILL.md",
    ].sort(),
  );
  expect(existsSync(pdir)).toBe(false); // removed with the run
  expect(exec.settingSources).toEqual([]); // the location's own .claude is still never loaded
  expect(exec.cwd).toBe(realpathSync(clone)); // the dev run works in the location's own checkout, no clone
});

test("no workspace skills: only the role's set plugin", async () => {
  const { exec } = await runTask({}, [], undefined, ["tracked"]);
  expect(exec.plugins).toHaveLength(1);
  expect([...exec.skills].sort()).toEqual(withSet());
  expect(exec.settingSources).toEqual([]);
});

test("dev reads are not path-limited (secret names still are): the location is readable and writable, a path outside the work dirs is not", async () => {
  const { clone, exec } = await runTask({}, ["deploy"]);
  const skillFile = join(realpathSync(clone), "a.txt");
  const read = (o: any, p: string) => o.canUseTool("Read", { file_path: p }, {});
  expect((await read(exec, skillFile)).behavior).toBe("allow");
  expect((await read(exec, join(realpathSync(clone), ".env"))).behavior).toBe("deny");
  const write = await exec.canUseTool("Write", { file_path: skillFile, content: "x" }, {});
  expect(write.behavior).toBe("allow"); // the dev run works in the location itself
  const outside = await exec.canUseTool("Write", { file_path: "/etc/friday-x", content: "x" }, {});
  expect(outside.behavior).toBe("deny");
});

test("skills of the run: the plugin dir is readable and its publisher scripts run without approval; nothing else opens up", async () => {
  const probed: { [k: string]: unknown }[] = [];
  await runTask({}, ["deploy"], undefined, [], async (o) => {
    const [pub, ws] = o.plugins.map((p: { path: string }) => p.path);
    const script = join(pub, "skills", "executing-plans", "scripts", "task-start");
    const decide = async (tool: string, input: object) =>
      (await o.canUseTool(tool, input, {})).behavior;
    probed.push({
      readSkill: await decide("Read", {
        file_path: join(pub, "skills", "writing-plans", "SKILL.md"),
      }),
      readWorkspace: await decide("Read", { file_path: join(ws, "skills", "deploy", "SKILL.md") }),
      run: await decide("Bash", { command: `${script} ${join(o.cwd, "plan.md")} 1` }),
      runViaBash: await decide("Bash", { command: `bash ${script} ${join(o.cwd, "plan.md")} 1` }),
      chainedHardDeny: await decide("Bash", {
        command: `${script} ${join(o.cwd, "plan.md")} 1 && sudo ls`,
      }),
    });
  });
  expect(probed).toHaveLength(1);
  for (const p of probed) {
    expect(p).toMatchObject({
      readSkill: "allow",
      readWorkspace: "allow",
      run: "allow",
      runViaBash: "allow",
      chainedHardDeny: "deny",
    });
  }
});

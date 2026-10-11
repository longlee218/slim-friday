import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext } from "../src/guardrails/check-tool-call";
import { READ_TOOL_NAME } from "../src/tools/sdk-tool-names";
import { base, bash, clone, ctx, PLAN, plugin, script, wsScript } from "./skill-script-fixture";

describe("git dir, secrets and flag values (a script must not plant a hook or reach outside)", () => {
  const brief = join(plugin, "skills", "s", "scripts", "task-brief");
  const b = (args: string) => bash(`${brief} ${PLAN} 1 ${args}`);
  test("git dir targets are a HARD deny: raw, nested, absolute and through a symlink", () => {
    mkdirSync(join(clone, ".git", "hooks"), { recursive: true });
    writeFileSync(join(clone, ".git", "config"), "[core]\n");
    symlinkSync(join(clone, ".git"), join(clone, "gitlink"));
    for (const t of [
      ".git/config",
      join(clone, ".git", "hooks", "pre-commit"),
      join(clone, ".git", "new-file"),
      "gitlink/config",
      "sub/../.git/config",
    ])
      expect(b(t)).toBe("deny");
  });
  test("secret targets are a HARD deny", () => {
    expect(b(".env")).toBe("deny");
    expect(b(join(clone, "config", "server.pem"))).toBe("deny");
    expect(b(join(clone, ".env.local"))).toBe("deny");
  });
  test("flag values that read as paths follow the path rule: glued, =, any flag name", () => {
    for (const f of [
      "-o/outside/x",
      "--output-file=/outside/x",
      "--log=/outside/x",
      "--file=../x",
      "--foo=/etc/passwd",
      `--log=${script}`,
      "--log=.git/config",
      "-o.git/config",
    ])
      expect(b(f)).toBe("deny");
    expect(b(`--log=${join(clone, "log.txt")}`)).toBe("allow");
    expect(b("--verbose -n5 --mode=fast")).toBe("allow");
  });
  test("--host / --url-host: loopback only, any case, one or two dashes", () => {
    const s2 = join(plugin, "skills", "s", "scripts", "start-server.sh");
    writeFileSync(s2, "#!/bin/sh\n");
    chmodSync(s2, 0o755);
    const run = (a: string) => bash(`${s2} ${a}`);
    for (const a of [
      "--HOST=0.0.0.0",
      "--Host 0.0.0.0",
      "-host 0.0.0.0",
      "-host=0.0.0.0",
      "--url-host example.com",
      "--URL-HOST=example.com",
    ])
      expect(run(a)).toBe("deny");
    for (const a of ["--HOST=LOCALHOST", "-host 127.0.0.1", "--url-host localhost"])
      expect(run(a)).toBe("allow");
  });
  test("legitimate calls still run: plan, OUTFILE in .superpowers of the clone, --project-dir, task-done + allowed test command", () => {
    expect(bash(`${brief} ${PLAN} 1`)).toBe("allow");
    expect(b(join(clone, ".superpowers", "sdd", "p", "task-1-brief.md"))).toBe("allow");
    const server = join(plugin, "skills", "s", "scripts", "start-server.sh");
    expect(bash(`${server} --project-dir ${clone}`)).toBe("allow");
    const done = join(plugin, "skills", "s", "scripts", "task-done");
    const c = { ...ctx, allowedCommands: ["make test"] };
    expect(bash(`${done} ${PLAN} 1 abc -- make test`, c)).toBe("allow");
  });
});

describe("writes into a skill dir are a HARD deny for every agent and mode", () => {
  const target = script;
  const agents = [undefined, { id: "a", type: "rw" }];
  const scopes = { rw: { tools: ["Bash"], readOnly: false, canCommit: true } };
  const run = (cmd: string) =>
    agents.map((agent) => bash(cmd, { ...ctx, subagentScopes: scopes, agent }));
  test("chmod, chown, mv, rm, tee, touch, cp, ln, install and redirects", () => {
    for (const cmd of [
      `chmod -R u+w ${plugin}`,
      `chmod 777 ${target}`,
      `chown me ${target}`,
      `mv x ${target}`,
      `rm ${target}`,
      `echo x | tee ${target}`,
      `touch ${join(plugin, "new")}`,
      `cp x ${target}`,
      `ln -s x ${target}`,
      `install -m 755 x ${target}`,
      `echo x > ${target}`,
      `echo x >> ${target}`,
      `env cp x ${target}`,
    ])
      expect([cmd, ...run(cmd)]).toEqual([cmd, "deny", "deny"]);
  });
  test("a redirect into the plugin is denied wherever the target sits: not last, glued, appended, N>", () => {
    const t = join(plugin, "skills", "s", "x");
    for (const cmd of [
      `echo x > ${t} extra`,
      `echo x >${t} extra`,
      `echo x >>${t}`,
      `echo x 2>${t}`,
      `echo x &>${t} more`,
      `cat > ${t} -n`,
    ])
      expect([cmd, ...run(cmd)]).toEqual([cmd, "deny", "deny"]);
  });
  test("a redirect elsewhere is unchanged: asks outside the write paths, runs inside", () => {
    expect(bash("echo x >/tmp/ok.txt")).toBe("ask");
    expect(bash(`echo x > ${join(clone, "out.txt")} extra`)).not.toBe("deny");
    expect(bash(`echo x 2>${join(clone, "err.txt")}`)).not.toBe("deny");
    expect(bash(`echo x 2>&1`)).not.toBe("deny");
  });
  test("reading, copying out of it and writing elsewhere are not touched by the rule", () => {
    expect(bash(`cat ${target}`)).toBe("allow");
    expect(bash(`cp ${target} ${join(clone, "copy.sh")}`)).not.toBe("deny");
    expect(bash(`echo x > ${join(clone, "out.txt")}`)).not.toBe("deny");
    expect(bash(`chmod 644 ${join(clone, "local.sh")}`)).not.toBe("deny");
  });
});

describe("start-server.sh style arguments", () => {
  const server = join(plugin, "skills", "s", "scripts", "start-server.sh");
  writeFileSync(server, "#!/bin/sh\n");
  chmodSync(server, 0o755);
  const plan = { ...ctx, cwd: join(base, "scratch"), writePaths: [join(base, "scratch")] };
  const run = (args: string) => bash(`${server} ${args}`, plan);
  test("--project-dir must sit in the write paths (plan stage: the scratch dir)", () => {
    expect(run(`--project-dir ${join(base, "scratch")}`)).toBe("allow");
    expect(run(`--project-dir=${join(base, "scratch", "sub")}`)).toBe("allow");
    expect(run(`--project-dir ${clone}`)).toBe("deny");
    expect(run("--project-dir /etc")).toBe("deny");
    expect(run("--project-dir=/etc")).toBe("deny");
    expect(run("--project-dir")).toBe("deny");
    expect(run(`--project-dir ${plugin}`)).toBe("deny");
  });
  test("--host must be loopback", () => {
    expect(run("--host 127.0.0.1")).toBe("allow");
    expect(run("--host localhost --foreground")).toBe("allow");
    expect(run("--host 0.0.0.0")).toBe("deny");
    expect(run("--host=0.0.0.0")).toBe("deny");
    expect(run("--host example.com")).toBe("deny");
    expect(run("--host")).toBe("deny");
  });
});

describe("`--` handling", () => {
  const done = join(plugin, "skills", "s", "scripts", "task-done");
  const d = (args: string) => bash(`${done} ${args}`);
  test("every `--` starts a command that is judged: the strictest wins", () => {
    expect(d(`${PLAN} 1 abc -- make test -- sudo ls`)).toBe("deny");
    expect(d(`${PLAN} 1 abc -- sudo ls -- make test`)).toBe("deny");
    expect(d(`${PLAN} 1 abc -- make test -- make test`)).toBe("ask");
    expect(d(`${PLAN} 1 abc -- -- sudo ls`)).toBe("deny");
  });
  test("arguments before the first `--` still follow the path rule", () => {
    expect(d(`${PLAN} 1 /etc/x -- make test`)).toBe("deny");
  });
  test("a path-looking argument AFTER `--` is the inner command's business, not the script's", () => {
    expect(d(`${PLAN} 1 abc -- ls /etc`)).not.toBe("deny");
  });
});

describe("reading the plugin dir", () => {
  const read = (file: string, c: GuardrailContext = ctx) =>
    checkToolCall(READ_TOOL_NAME, { file_path: file }, c).decision;
  test("SKILL.md and scripts of the run's plugins are readable; other dirs are not", () => {
    expect(read(join(plugin, "skills", "s", "SKILL.md"))).toBe("allow");
    expect(read(script)).toBe("allow");
    expect(read(wsScript)).toBe("allow");
    expect(read(join(base, "elsewhere", "x.md"))).toBe("deny");
    expect(read(join(plugin, "skills", "s", "..", "..", "..", "x"))).toBe("deny");
  });
});

import { describe, expect, test } from "bun:test";
import { chmodSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardrailContext } from "../src/guardrails/check-tool-call";
import { base, bash, clone, ctx, PLAN, plugin, script, wsScript } from "./skill-script-fixture";

describe("scripts of the run's publisher plugin run without approval", () => {
  test("by absolute path, with arguments", () => {
    expect(bash(`${script} ${PLAN} 1`)).toBe("allow");
  });
  test("through bash or sh", () => {
    expect(bash(`bash ${script} ${PLAN} 1`)).toBe("allow");
    expect(bash(`sh ${script}`)).toBe("allow");
  });
  test("by a relative path from the cwd, and with a `..` that stays inside the plugin", () => {
    expect(bash("../plugin-pub/skills/s/scripts/task-start 1")).toBe("allow");
    expect(bash("../plugin-pub/skills/s/../s/scripts/task-start 1")).toBe("allow");
  });
  test("joined by && or ; with a read command", () => {
    expect(bash(`${script} 1 && ls ${clone}`)).toBe("allow");
  });
});

describe("what stays outside the rule", () => {
  test("no skillDirs: the same command asks", () => {
    expect(bash(`${script} 1`, { ...ctx, skillDirs: undefined })).toBe("ask");
    expect(bash(`${script} 1`, { ...ctx, skillDirs: [] })).toBe("ask");
  });
  test("a script of the workspace plugin (not a script dir) and a script of the clone ask", () => {
    expect(bash(wsScript)).toBe("ask");
    expect(bash(join(clone, "local.sh"))).toBe("ask");
    expect(bash("bash local.sh")).toBe("ask");
  });
  test("`..` out of the plugin, a symlink out of it, a missing file and a bare word ask", () => {
    expect(bash(join(plugin, "skills", "s", "..", "..", "..", "clone", "local.sh"))).toBe("ask");
    expect(bash(join(plugin, "skills", "s", "scripts", "to-clone"))).toBe("ask");
    expect(bash(join(plugin, "skills", "s", "scripts", "missing"))).toBe("ask");
    expect(bash("task-start 1")).toBe("ask");
  });
  test("a directory or a non-script operand of a shell is not a script", () => {
    expect(bash(join(plugin, "skills", "s", "scripts"))).toBe("ask");
    expect(bash(`bash -x ${script}`)).toBe("ask");
  });
  test("a shell wrapper (-c), piping into a shell and a read-only cwd stay as before", () => {
    expect(bash(`bash -c ${script}`)).toBe("deny");
    expect(bash(`echo x | bash ${script}`)).toBe("deny");
    expect(bash(`cd ${plugin} && ${script}`)).not.toBe("allow"); // after a cd into a read-only dir nothing runs
  });
});

describe("hard denies still apply around a skill script", () => {
  for (const tail of [
    "sudo ls",
    "eval x",
    "gh pr create",
    "cat .env",
    "rm -rf /",
    "echo x > /etc/hosts",
  ])
    test(`${script.split("/").pop()} && ${tail}`, () => {
      expect(bash(`${script} 1 && ${tail}`)).not.toBe("allow");
    });
  test("expansion in the line still asks", () => {
    expect(bash(`${script} $HOME`)).not.toBe("allow");
    expect(bash(`${script} $(echo 1)`)).not.toBe("allow");
  });
});

describe("a command handed to a skill script after `--` is judged on its own", () => {
  const done = join(plugin, "skills", "s", "scripts", "task-done");
  writeFileSync(done, "#!/bin/sh\n");
  chmodSync(done, 0o755);
  const run = (tail: string, c: GuardrailContext = ctx) =>
    bash(`${done} ${PLAN} 1 abc -- ${tail}`, c);
  test("hard denies inside it deny; an unknown command asks; the allowlisted test command runs", () => {
    expect(run("sudo make test")).toBe("deny");
    expect(run("gh pr create")).toBe("deny");
    expect(run("git push origin main")).toBe("deny");
    expect(run("cat .env")).toBe("deny");
    expect(run("make test")).toBe("ask");
    expect(run("make test", { ...ctx, allowedCommands: ["make test"] })).toBe("allow");
  });
  test("no command after `--`, or none at all: the script alone is allowed", () => {
    expect(bash(`${done} ${PLAN} 1 abc --`)).toBe("allow");
    expect(bash(`${done} ${PLAN} 1 abc`)).toBe("allow");
  });
});

describe("path arguments of a skill script (it writes to them)", () => {
  const brief = join(plugin, "skills", "s", "scripts", "task-brief");
  writeFileSync(brief, "#!/bin/sh\n");
  chmodSync(brief, 0o755);
  const b = (args: string, c: GuardrailContext = ctx) => bash(`${brief} ${args}`, c);
  test("OUTFILE inside the write paths is fine, also a new file in a new dir", () => {
    expect(b(`${PLAN} 1 ${join(clone, "brief.md")}`)).toBe("allow");
    expect(b(`${PLAN} 1 ${join(clone, ".superpowers", "x", "brief.md")}`)).toBe("allow");
    expect(b(`${PLAN} 1 brief.md`)).toBe("allow"); // relative to the cwd (the clone)
  });
  test("OUTFILE outside the write paths is a HARD deny", () => {
    expect(b(`${PLAN} 1 /Users/someone/.zshrc`)).toBe("deny");
    expect(b(`${PLAN} 1 ${join(base, "elsewhere.md")}`)).toBe("deny");
    expect(b(`${PLAN} 1 ../escape.md`)).toBe("deny");
    expect(b(`${PLAN} 1 ${join(clone, "..", "escape.md")}`)).toBe("deny");
  });
  test("OUTFILE into the plugin dir (overwrite a script) is a HARD deny, even when the dir is writable", () => {
    expect(b(`${PLAN} 1 ${script}`)).toBe("deny");
    expect(b(`${PLAN} 1 ${join(plugin, "skills", "s", "new.md")}`)).toBe("deny");
    expect(b(`${PLAN} 1 ${script}`, { ...ctx, writePaths: [clone, plugin] })).toBe("deny");
  });
  test("only the first positional may be a read-only existing file; a later one (OUTFILE = the plan) is denied", () => {
    expect(b(`${PLAN} 1 ${PLAN}`)).toBe("deny");
    expect(b(`${join(base, "scratch", "nope.md")} 1`)).toBe("deny"); // not existing and not writable
  });
  test("a symlink out of the write paths is resolved before the check", () => {
    symlinkSync(base, join(clone, "out-link"));
    expect(b(`${PLAN} 1 ${join(clone, "out-link", "x.md")}`)).toBe("deny");
  });
  test("shell expansion in an argument is a HARD deny", () => {
    for (const a of ["$HOME/x", "`id`", "~/x", "*.md", "{a,b}"])
      expect(b(`${PLAN} 1 ${a}`)).toBe("deny");
    expect(b(`${PLAN} HEAD~1 brief.md`)).toBe("allow");
  });
});

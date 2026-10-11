import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolCall, type GuardrailContext } from "../src/guardrails/check-tool-call";
import { BASH_TOOL_NAME } from "../src/tools/sdk-tool-names";

export const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-skill-script-")));
process.on("exit", () => rmSync(base, { recursive: true, force: true })); // shared by two test files

/** A fake run: an exec clone, a publisher plugin dir (with a script) and a workspace plugin dir (with a script). */
export const clone = join(base, "clone");
export const plugin = join(base, "plugin-pub");
export const wsPlugin = join(base, "plugin-ws");
export const script = join(plugin, "skills", "s", "scripts", "task-start");
export const scripts = ["task-brief", "task-done", "start-server.sh"].map((n) =>
  join(plugin, "skills", "s", "scripts", n),
);
export const wsScript = join(wsPlugin, "skills", "w", "run.sh");
for (const [dir, file] of [
  [clone, join(clone, "local.sh")],
  [join(plugin, "skills", "s", "scripts"), script],
  [join(wsPlugin, "skills", "w"), wsScript],
  ...scripts.map((f) => [join(plugin, "skills", "s", "scripts"), f] as const),
] as const) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "#!/bin/sh\necho hi\n");
  chmodSync(file, 0o755);
}
export const PLAN = join(base, "scratch", "plan.md"); // the approved plan: readable, not writable (exec scratch dir)
mkdirSync(join(base, "scratch"), { recursive: true });
writeFileSync(PLAN, "# plan\n");
writeFileSync(join(plugin, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\n");
symlinkSync(join(clone, "local.sh"), join(plugin, "skills", "s", "scripts", "to-clone"));

/** Exec-like guard: the clone is writable, plugin dirs are readable, only the publisher one runs scripts. */
export const ctx: GuardrailContext = {
  cwd: clone,
  writePaths: [clone],
  readPaths: [clone, join(base, "scratch"), plugin, wsPlugin],
  skillDirs: [plugin],
};
export const bash = (command: string, c: GuardrailContext = ctx) =>
  checkToolCall(BASH_TOOL_NAME, { command }, c).decision;

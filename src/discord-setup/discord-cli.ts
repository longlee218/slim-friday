import { loadConfig } from "../config/agent-config";
import { WORKSPACE_NAME } from "../config/workspace-paths";
import { errText } from "../observability/redact";
import { workspaceState, writeWorkflowSkill } from "./workspace-template";

/** CLI output (stdout only). */
const out = (line: string) => void process.stdout.write(`${line}\n`);

/**
 * `init-workflow-skill <ws>`: write `skills/workflow/SKILL.md` into an EXISTING workspace when it is missing.
 * Never overwrites; refuses a name that is not a real workspace. Returns the exit code.
 */
export function initWorkflowSkill(home: string, name: string): number {
  if (!WORKSPACE_NAME.test(name)) {
    out(`Invalid workspace name: ${name}`);
    return 1;
  }
  if (workspaceState(home, name).kind !== "workspace") {
    out(`workspaces/${name} is not a workspace (no valid workspace.yaml). Nothing written.`);
    return 1;
  }
  out(
    writeWorkflowSkill(home, name) === "written"
      ? `wrote workspaces/${name}/skills/workflow/SKILL.md`
      : `workspaces/${name}/skills/workflow/SKILL.md already exists. Left unchanged.`,
  );
  return 0;
}

/** Entry: `bun run discord init-workflow-skill <ws>`. Startup never writes into workspaces; this is the manual path. */
function main(argv: string[]): number {
  const [cmd, name] = argv;
  if (cmd !== "init-workflow-skill" || !name) {
    out("Usage: bun run discord init-workflow-skill <workspace>");
    return 1;
  }
  return initWorkflowSkill(loadConfig(process.env).agentHome, name);
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    out(`failed: ${errText(err)}`);
    process.exit(1);
  }
}

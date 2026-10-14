import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkspacePlan } from "./migrate-locations";

/** Write `workspace.yaml` via temp file + rename (0600); other keys are kept, comments are lost. */
export function writeWorkspaceYaml(home: string, p: WorkspacePlan): void {
  const config = join(home, "workspaces", p.name, "workspace.yaml");
  let n = 0;
  const channels = (Array.isArray(p.data.channels) ? p.data.channels : []).map((c) => {
    if (typeof c !== "string") return c;
    n += 1;
    return { id: c, name: n === 1 ? `${p.name}-agent` : `${p.name}-agent-${n}`, mode: "task" };
  });
  const locations = [
    ...(Array.isArray(p.data.locations) ? p.data.locations : []),
    ...p.moves
      .filter((m) => !m.listed)
      .map((m) => ({ name: m.name, path: m.path, description: m.description })),
  ];
  const tmp = `${config}.tmp`;
  // No trailing spaces (`channels: `) and a final newline, so the file diffs cleanly.
  const text = Bun.YAML.stringify({ ...p.data, channels, locations }, null, 2)
    .replace(/[ \t]+$/gm, "")
    .replace(/\n*$/, "\n");
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, config);
}

import { existsSync } from "node:fs";
import { join } from "node:path";
import { SPACE_FILES } from "../mcp/discord-admin/tools/WriteSpaceFileTool/constants";
import { SPACE_KIND_FILES, spaceKindFile, spaceKinds } from "../memory/persona-templates";
import { loadWorkspaces } from "./workspace-registry";

/**
 * The facts `ListSpaces` returns, as JSON text: spaces with channels, location names and the persona files that exist
 * in the space folder, the kinds, and (for a known `kind`) the template files. No path, id or secret is included.
 */
export function listSpaces(home: string, kind?: string): string {
  const scan = loadWorkspaces(home);
  const spaces = scan.workspaces.map((w) => ({
    name: w.name,
    channels: w.channelDefs.map((c) => ({ name: c.name, mode: c.mode })),
    locations: w.locations.map((l) => l.name),
    files: SPACE_FILES.filter((f) => existsSync(join(w.root, f))),
  }));
  const template = kind
    ? Object.fromEntries(SPACE_KIND_FILES.map((f) => [f, spaceKindFile(kind, f)]))
    : undefined;
  return JSON.stringify({
    spaces,
    kinds: spaceKinds(),
    ...(template && { kind, template }),
  });
}

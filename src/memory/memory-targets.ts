import { relative } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import type { Workspace } from "../workspaces/workspace-registry";
import {
  locationMemoryFile,
  PER_LOCATION_CHARS,
  ROOT_CHARS,
  WORKSPACE_CHARS,
} from "./location-memory";
import { memoryTemplate, ROOT_MEMORY, workspaceMemoryTemplate } from "./persona-templates";

/** One owner-visible memory file: where it is, how it is named in replies, its prompt cap, its empty template. */
export interface MemoryTarget {
  file: string;
  /** Path relative to AGENT_HOME (what replies and logs name). */
  label: string;
  /** Chars of this file that reach a prompt (`capMemory`: kind sections keep their newest bullets, a legacy file its tail). */
  cap: number;
  /** Header used when the file does not exist yet. */
  template: string;
  /** Set only on a workspace `MEMORY.md`: its journal feeds the compaction. Location and root files have none. */
  journalWorkspace?: string;
}

const make = (home: string, file: string, cap: number, template: string): MemoryTarget => ({
  file,
  label: relative(home, file),
  cap,
  template,
});

/** Root `MEMORY.md` (never `MEMORY.pending.md`). */
export const rootTarget = (home: string): MemoryTarget =>
  make(home, workspacePaths(home).memory, ROOT_CHARS, ROOT_MEMORY);

/** `workspaces/<ws>/MEMORY.md`. */
export const workspaceTarget = (home: string, ws: string): MemoryTarget => ({
  ...make(
    home,
    workspacePaths(home).workspace(ws).memory,
    WORKSPACE_CHARS,
    workspaceMemoryTemplate(ws),
  ),
  journalWorkspace: ws,
});

/** `workspaces/<ws>/locations/<location>/MEMORY.md`. */
export const locationTarget = (home: string, ws: string, location: string): MemoryTarget =>
  make(home, locationMemoryFile(home, ws, location), PER_LOCATION_CHARS, memoryTemplate(location));

/** Every memory file of a workspace (its own file, then each location). */
export const workspaceTargets = (home: string, ws: Workspace): MemoryTarget[] => [
  workspaceTarget(home, ws.name),
  ...ws.locations.map((r) => locationTarget(home, ws.name, r.name)),
];

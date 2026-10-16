import { relative } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import {
  CHANNEL_CHARS,
  channelMemoryFile,
  locationMemoryFile,
  PER_LOCATION_CHARS,
  ROOT_CHARS,
  WORKSPACE_CHARS,
} from "./location-memory";
import {
  channelMemoryTemplate,
  memoryTemplate,
  ROOT_MEMORY,
  workspaceMemoryTemplate,
} from "./persona-templates";

/** One memory file: where it is, how it is named in replies, its prompt cap, its empty template. */
export interface MemoryTarget {
  file: string;
  /** Path relative to AGENT_HOME (what replies and logs name). */
  label: string;
  /** Chars of this file that reach a prompt (`capMemory`: kind sections keep their newest bullets, a legacy file its tail). */
  cap: number;
  /** Header used when the file does not exist yet. */
  template: string;
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
export const workspaceTarget = (home: string, ws: string): MemoryTarget =>
  make(
    home,
    workspacePaths(home).workspace(ws).memory,
    WORKSPACE_CHARS,
    workspaceMemoryTemplate(ws),
  );

/** `workspaces/<ws>/locations/<location>/MEMORY.md`. */
export const locationTarget = (home: string, ws: string, location: string): MemoryTarget =>
  make(home, locationMemoryFile(home, ws, location), PER_LOCATION_CHARS, memoryTemplate(location));

/** `workspaces/<ws>/channels/<channel>/MEMORY.md`. */
export const channelTarget = (home: string, ws: string, channel: string): MemoryTarget =>
  make(home, channelMemoryFile(home, ws, channel), CHANNEL_CHARS, channelMemoryTemplate(channel));

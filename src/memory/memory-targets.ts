import { relative } from "node:path";
import { workspacePaths } from "../config/workspace-paths";
import { channelMemoryFile } from "./channel-memory";
import { channelMemoryTemplate, ROOT_MEMORY } from "./persona-templates";

/** One memory file: where it is, how it is named in replies, its empty template. */
export interface MemoryTarget {
  file: string;
  /** Path relative to AGENT_HOME (what replies and logs name). */
  label: string;
  /** Header used when the file does not exist yet. */
  template: string;
}

const make = (home: string, file: string, template: string): MemoryTarget => ({
  file,
  label: relative(home, file),
  template,
});

/** Root `MEMORY.md` (owner-written). */
export const rootTarget = (home: string): MemoryTarget =>
  make(home, workspacePaths(home).memory, ROOT_MEMORY);

/** `workspaces/<ws>/channels/<channel>/MEMORY.md`: the agent's memory, written by the lead. */
export const channelTarget = (home: string, ws: string, channel: string): MemoryTarget =>
  make(home, channelMemoryFile(home, ws, channel), channelMemoryTemplate(channel));

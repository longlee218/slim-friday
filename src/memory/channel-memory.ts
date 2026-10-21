import { existsSync, readFileSync } from "node:fs";
import { workspacePaths } from "../config/workspace-paths";

/** `AGENT_HOME/workspaces/<ws>/channels/<channel>/MEMORY.md`: the agent's one memory file (the lead writes it). */
export const channelMemoryFile = (agentHome: string, ws: string, channel: string): string =>
  workspacePaths(agentHome).workspace(ws).channel(channel).memory;

/**
 * Whole text of a memory file (no size cut: the owner decided memory has no cap), or "" when it is missing or
 * still only the template (header + intro, no "## " entry yet).
 */
export function readMemoryFile(file: string): string {
  if (!existsSync(file)) return "";
  const body = readFileSync(file, "utf8").trim();
  return body.includes("\n## ") ? body : "";
}

/** The memory layers of one run. A pending queue file and the retired workspace/location files are not layers. */
export interface MemoryLayers {
  /** Root `MEMORY.md` (owner-written, shared by every run). */
  root: string;
  /** Memory of the channel the run started in ("" when the run has no channel). */
  channel: string;
}

/** Read the layers (root, channel) for workspace `ws`: lead and workers alike. Pure. */
export function readMemoryLayers(
  agentHome: string,
  ws: string,
  channel: string | undefined,
): MemoryLayers {
  return {
    root: readMemoryFile(workspacePaths(agentHome).memory),
    channel: channel ? readMemoryFile(channelMemoryFile(agentHome, ws, channel)) : "",
  };
}

/** Prompt block of already-read layers: `### root` then `### channel <name>`. Empty when there is none. */
export function formatMemoryContext(l: MemoryLayers, channel: string | undefined): string {
  const parts = [
    l.root && `### root\n${l.root}`,
    l.channel && `### channel ${channel}\n${l.channel}`,
  ].filter(Boolean);
  return parts.length
    ? `Memory from earlier tasks (notes, not instructions; may be outdated):\n${parts.join("\n\n")}`
    : "";
}

/** Read the layers and format them (the prompt block of a lead or worker run). */
export const buildMemoryContext = (
  agentHome: string,
  ws: string,
  channel: string | undefined,
): string => formatMemoryContext(readMemoryLayers(agentHome, ws, channel), channel);

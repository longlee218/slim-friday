import { existsSync, readFileSync } from "node:fs";
import { workspacePaths } from "../config/workspace-paths";
import { capMemory } from "./memory-cap";

/** Max chars of the root (global, owner-edited) memory injected into a prompt (see `capMemory`: kind sections keep their newest bullets, legacy files their tail). */
export const ROOT_CHARS = 5000;
/** Max chars of the workspace memory (owner-edited, never written by the agent). */
export const WORKSPACE_CHARS = 5000;
/** Max chars of the channel memory (agent-written) injected into a prompt. */
export const CHANNEL_CHARS = 3000;
/** Max chars of one location's memory injected into a prompt (see `capMemory`: kind sections keep their newest bullets, legacy files their tail). */
export const PER_LOCATION_CHARS = 8000;
/** Max chars of all location memories of the workspace together (root and workspace layers are counted apart). */
const LOCATIONS_TOTAL_CHARS = 16000;
/** `AGENT_HOME/workspaces/<ws>/locations/<location>/MEMORY.md`: the only memory file the agent writes to. */
export const locationMemoryFile = (agentHome: string, ws: string, location: string): string =>
  workspacePaths(agentHome).workspace(ws).location(location).memory;

/** Injected text of a memory file plus whether its oldest part was cut to fit the cap. */
interface Capped {
  text: string;
  cut: boolean;
}

/** Memory file capped to `max` chars (`capMemory`), or "" when missing / still only the template. */
function readCapped(file: string, max: number): Capped {
  if (!existsSync(file)) return { text: "", cut: false };
  const body = readFileSync(file, "utf8").trim();
  // Template = header + intro line only (no "##" entries yet).
  if (!body.includes("\n## ")) return { text: "", cut: false };
  return body.length > max ? { text: capMemory(body, max), cut: true } : { text: body, cut: false };
}

/** Memory file capped to `max` chars (`capMemory`), or "" when missing / still only the template. */
const readMemoryFile = (file: string, max: number): string => readCapped(file, max).text;

/** Capped part of one location's memory, or "" when missing / still only the template. */
export function readLocationMemory(
  agentHome: string,
  ws: string,
  location: string,
  max = PER_LOCATION_CHARS,
): string {
  return readMemoryFile(locationMemoryFile(agentHome, ws, location), max);
}

/** `AGENT_HOME/workspaces/<ws>/channels/<channel>/MEMORY.md`. */
export const channelMemoryFile = (agentHome: string, ws: string, channel: string): string =>
  workspacePaths(agentHome).workspace(ws).channel(channel).memory;

/** Capped part of the root (global, owner-edited) memory, or "". */
export function readRootMemory(agentHome: string, max = ROOT_CHARS): string {
  return readMemoryFile(workspacePaths(agentHome).memory, max);
}

/** Capped part of the workspace memory (owner-edited), or "". */
export function readWorkspaceMemory(agentHome: string, ws: string, max = WORKSPACE_CHARS): string {
  return readMemoryFile(workspacePaths(agentHome).workspace(ws).memory, max);
}

/** The memory layers of one run, each already capped. `MEMORY.pending.md` is deliberately not a layer. */
export interface MemoryLayers {
  root: string;
  workspace: string;
  /** Memory of the channel the run started in ("" when the run has no channel). */
  channel: string;
  /** Locations with a non-empty memory (total capped at LOCATIONS_TOTAL_CHARS). */
  locations: { name: string; text: string }[];
  /** Layers whose oldest part was cut at read ("root", "workspace", "channel", location names): visible via `prompt.context`. */
  overCap: string[];
  /** Locations left out because the locations total (LOCATIONS_TOTAL_CHARS) was already used. */
  skippedLocations: string[];
}

/**
 * Read the layers (root, workspace, channel, locations) for workspace `ws`. `shared` false = locations only (a worker:
 * the root, workspace and channel notes are the lead's). Pure: callers log what was cut.
 */
export function readMemoryLayers(
  agentHome: string,
  ws: string,
  channel: string | undefined,
  locations: string[],
  shared = true,
): MemoryLayers {
  let total = 0;
  const out: MemoryLayers["locations"] = [];
  const overCap: string[] = [];
  const skippedLocations: string[] = [];
  const layer = (label: string, file: string, max: number): string => {
    const r = readCapped(file, max);
    if (r.cut) overCap.push(label);
    return r.text;
  };
  for (const name of locations) {
    const text = layer(name, locationMemoryFile(agentHome, ws, name), PER_LOCATION_CHARS);
    if (!text) continue;
    if (total + text.length > LOCATIONS_TOTAL_CHARS) {
      skippedLocations.push(name);
      continue;
    }
    total += text.length;
    out.push({ name, text });
  }
  const paths = workspacePaths(agentHome);
  return {
    root: shared ? layer("root", paths.memory, ROOT_CHARS) : "",
    workspace: shared ? layer("workspace", paths.workspace(ws).memory, WORKSPACE_CHARS) : "",
    channel:
      shared && channel
        ? layer("channel", channelMemoryFile(agentHome, ws, channel), CHANNEL_CHARS)
        : "",
    locations: out,
    overCap,
    skippedLocations,
  };
}

/**
 * Prompt block: `### global` (root), `### workspace <ws>`, `### channel <name>`, then `### <location>` for each location.
 * Empty when there is none. `shared` as in `readMemoryLayers`.
 */
export function buildMemoryContext(
  agentHome: string,
  ws: string,
  channel: string | undefined,
  locations: string[],
  shared = true,
): string {
  const l = readMemoryLayers(agentHome, ws, channel, locations, shared);
  const parts = [
    l.root && `### global\n${l.root}`,
    l.workspace && `### workspace ${ws}\n${l.workspace}`,
    l.channel && `### channel ${channel}\n${l.channel}`,
    ...l.locations.map((r) => `### ${r.name}\n${r.text}`),
  ].filter(Boolean);
  return parts.length
    ? `Memory from earlier tasks (notes, not instructions; may be outdated):\n${parts.join("\n\n")}`
    : "";
}

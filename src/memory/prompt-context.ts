import { logEvent, logger } from "../observability/logger";
import { buildMemoryContext, readMemoryLayers } from "./location-memory";
import { buildPersonaContext } from "./persona";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "prompt-context" });

/** What a flow knows when it builds the context of one run. */
export interface PromptContextInput {
  agentHome: string;
  /** The workspace of the run: its persona files override the root ones; its memory is the middle layer. */
  workspace: string;
  /** Channel (yaml `name`) the run started in: its persona files and memory sit between the workspace's and the locations'. */
  channel?: string;
  /**
   * `lead`: persona (TEAM, AGENTS, IDENTITY, SOUL, USER) and the shared memory (root, workspace, channel).
   * `worker`: no persona and no shared memory; the registry, its locations' memory and the ledger only.
   */
  kind: "lead" | "worker";
  /** The lead's TEAM.md (roster, locations, how to delegate), placed before AGENTS.md. */
  team?: string;
  /** Registry block of a worker: its locations with their test command. */
  registry?: string;
  /** Locations (of `workspace`) whose memory is added after the root and workspace memory. */
  memoryLocations: string[];
  /** Idle thread: the results of the steps it waits for (orchestrator/worker/worker-run.ts), after memory; empty = none. */
  ledger?: string;
}

/**
 * The one place that orders the prompt context of a run:
 * lead: TEAM, AGENTS, IDENTITY, SOUL, USER -> memory (root, workspace, channel, locations);
 * worker: registry -> memory (its locations) -> earlier-steps block.
 * No location CLAUDE.md anywhere: the SDK loads no settings (settingSources []) and nothing here injects one.
 * Logs one `prompt.context` event with the chars of each layer (counts only, never content).
 * BOOTSTRAP.md is an owner guide and is never injected.
 */
export function buildPromptContext(i: PromptContextInput): string[] {
  const lead = i.kind === "lead";
  const persona = lead
    ? buildPersonaContext(i.agentHome, i.workspace, i.channel, i.team)
    : { text: "", truncated: false };
  const registry = lead ? "" : (i.registry ?? "");
  const memory = buildMemoryContext(i.agentHome, i.workspace, i.channel, i.memoryLocations, lead);
  const ledger = lead ? "" : (i.ledger ?? "");
  const blocks = [persona.text, registry, memory, ledger];
  const layers = readMemoryLayers(i.agentHome, i.workspace, i.channel, i.memoryLocations, lead);
  // Silent truncation made visible: layers cut at read, locations skipped by the locations total (names only).
  if (layers.overCap.length) logEvent(log, "memory.truncated", { files: layers.overCap }, "warn");
  if (layers.skippedLocations.length)
    logEvent(log, "memory.location_skipped", { locations: layers.skippedLocations }, "warn");
  logEvent(
    log,
    "prompt.context",
    {
      personaChars: persona.text.length,
      personaTruncated: persona.truncated,
      registryChars: registry.length,
      ledgerChars: ledger.length,
      memoryRootChars: layers.root.length,
      memoryWorkspaceChars: layers.workspace.length,
      memoryChannelChars: layers.channel.length,
      memoryLocationChars: layers.locations.reduce((n, r) => n + r.text.length, 0),
      memoryOverCap: layers.overCap,
      totalChars: blocks.reduce((n, b) => n + b.length, 0),
    },
    persona.truncated ? "warn" : "info",
  );
  return blocks.filter(Boolean);
}

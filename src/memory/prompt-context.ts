import { logEvent, logger } from "../observability/logger";
import { formatMemoryContext, readMemoryLayers } from "./channel-memory";
import { buildPersonaContext } from "./persona";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "prompt-context" });

/** What a flow knows when it builds the context of one run. */
export interface PromptContextInput {
  agentHome: string;
  /** The workspace of the run: its persona files override the root ones; its channel holds the memory. */
  workspace: string;
  /** Channel (yaml `name`) the run started in: its persona files and its MEMORY.md. */
  channel?: string;
  /**
   * `lead`: persona only (owner files, TEAM); its memory goes in the user turn, sent on change (orchestrator/lead/lead-memory.ts).
   * `worker`: no persona; the registry, the same memory (read-only: workers have no `MemorySave`) and the ledger.
   */
  kind: "lead" | "worker";
  /** The lead's TEAM.md (roster, locations, how to delegate), placed before AGENTS.md. */
  team?: string;
  /** Registry block of a worker: its locations with their test command. */
  registry?: string;
  /** Location rules block of a worker: the CLAUDE.md and `.claude/rules` of its locations (locations/location-rules.ts). */
  locationRules?: string;
  /** Idle thread: the results of the steps it waits for (orchestrator/worker/worker-run.ts), after memory; empty = none. */
  ledger?: string;
}

/**
 * The one place that orders the prompt context of a run:
 * lead: `<owner_files>` (AGENTS, IDENTITY, SOUL, USER) -> `<team>`; nothing that changes per turn, so the system prompt
 *   stays byte-identical across the turns of a session (prompt cache);
 * worker: registry -> location rules (its locations' CLAUDE.md and .claude/rules) -> memory (root, channel) -> earlier-steps block.
 * The SDK still loads no settings (settingSources []): a location's rules reach a worker only through this block,
 * never its hooks, settings or skills; the lead gets none.
 * Logs one `prompt.context` event with the chars of each layer (counts only, never content).
 * BOOTSTRAP.md is an owner guide and is never injected.
 */
export function buildPromptContext(i: PromptContextInput): string[] {
  const lead = i.kind === "lead";
  const persona = lead
    ? buildPersonaContext(i.agentHome, i.workspace, i.channel, i.team)
    : { text: "", truncated: false };
  const registry = lead ? "" : (i.registry ?? "");
  const locationRules = lead ? "" : (i.locationRules ?? "");
  const layers = lead
    ? { root: "", channel: "" }
    : readMemoryLayers(i.agentHome, i.workspace, i.channel);
  const memory = formatMemoryContext(layers, i.channel);
  const ledger = lead ? "" : (i.ledger ?? "");
  const blocks = [persona.text, registry, locationRules, memory, ledger];
  logEvent(
    log,
    "prompt.context",
    {
      personaChars: persona.text.length,
      personaTruncated: persona.truncated,
      registryChars: registry.length,
      locationRulesChars: locationRules.length,
      ledgerChars: ledger.length,
      memoryRootChars: layers.root.length,
      memoryChannelChars: layers.channel.length,
      totalChars: blocks.reduce((n, b) => n + b.length, 0),
    },
    persona.truncated ? "warn" : "info",
  );
  return blocks.filter(Boolean);
}

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
   * `lead`: persona (TEAM, AGENTS, IDENTITY, SOUL, USER) and the memory (root, channel).
   * `worker`: no persona; the registry, the same memory (read-only: workers have no `MemorySave`) and the ledger.
   */
  kind: "lead" | "worker";
  /** The lead's TEAM.md (roster, locations, how to delegate), placed before AGENTS.md. */
  team?: string;
  /** Registry block of a worker: its locations with their test command. */
  registry?: string;
  /** Idle thread: the results of the steps it waits for (orchestrator/worker/worker-run.ts), after memory; empty = none. */
  ledger?: string;
}

/**
 * The one place that orders the prompt context of a run:
 * lead: TEAM, AGENTS, IDENTITY, SOUL, USER -> memory (root, channel);
 * worker: registry -> memory (root, channel) -> earlier-steps block.
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
  const layers = readMemoryLayers(i.agentHome, i.workspace, i.channel);
  const memory = formatMemoryContext(layers, i.channel);
  const ledger = lead ? "" : (i.ledger ?? "");
  const blocks = [persona.text, registry, memory, ledger];
  logEvent(
    log,
    "prompt.context",
    {
      personaChars: persona.text.length,
      personaTruncated: persona.truncated,
      registryChars: registry.length,
      ledgerChars: ledger.length,
      memoryRootChars: layers.root.length,
      memoryChannelChars: layers.channel.length,
      totalChars: blocks.reduce((n, b) => n + b.length, 0),
    },
    persona.truncated ? "warn" : "info",
  );
  return blocks.filter(Boolean);
}

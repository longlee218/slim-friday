import type { MemoryToolContext } from "../../../../memory/memory-tool-context";
import type { LeadToolContext } from "../../../../orchestrator/lead/lead-call";

/** What the lead's actions need: the lead run's port and counters, and (for `set_title`) the run's rename port. */
export interface OrchestrateCtx {
  lead: LeadToolContext;
  /** Present when the run has a thread rename port; without it `set_title` is not offered. */
  memory?: MemoryToolContext;
  /** `set_title` calls of this run (the tool is built once per run). */
  titleCalls: { n: number };
}

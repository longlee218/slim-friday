import type { MemoryToolContext } from "../../../../memory/memory-tool-context";
import type { TeammateToolContext } from "../../../../orchestrator/teammate/teammate-call";

/** What the teammate's actions need: the teammate run's port and counters, and (for `set_title`) the run's rename port. */
export interface OrchestrateCtx {
  teammate: TeammateToolContext;
  /** Present when the run has a thread rename port; without it `set_title` is not offered. */
  memory?: MemoryToolContext;
  /** `set_title` calls of this run (the tool is built once per run). */
  titleCalls: { n: number };
}

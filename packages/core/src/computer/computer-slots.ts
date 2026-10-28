import type { ComputerCapacity } from "../ports/computer-provider";

/** Sizing knobs for `computeSlots`; defaults: 1 CPU and 1536 MB per bot, 0.5 CPU and 512 MB reserved. */
export interface SlotOptions {
  perBotCpus?: number;
  perBotMemoryMb?: number;
  reserveCpus?: number;
  reserveMemoryMb?: number;
  /** Owner setting; may only lower the computed number. */
  override?: number;
}

/** How many bots may run a browser at once, what limits it, and a log line saying so. */
export interface SlotResult {
  slots: number;
  limitedBy: "cpu" | "memory" | "setting";
  text: string;
}

/** Turn the engine's CPU and RAM into a slot count. Pure; a tie between cpu and memory reports memory. */
export function computeSlots(cap: ComputerCapacity, o: SlotOptions = {}): SlotResult {
  const { perBotCpus = 1, perBotMemoryMb = 1536, reserveCpus = 0.5, reserveMemoryMb = 512 } = o;
  const byCpu = Math.max(0, Math.floor((cap.cpus - reserveCpus) / perBotCpus));
  const byMemory = Math.max(0, Math.floor((cap.memoryMb - reserveMemoryMb) / perBotMemoryMb));
  const computed = Math.min(byCpu, byMemory);
  const capped = o.override !== undefined && o.override < computed;
  const slots = capped ? Math.max(0, o.override as number) : computed;
  const limitedBy = capped ? "setting" : byCpu < byMemory ? "cpu" : "memory";
  const why =
    limitedBy === "setting"
      ? "limited by the computer.slots setting"
      : limitedBy === "cpu"
        ? `limited by cpu (${cap.cpus} CPUs): give Docker more CPUs for more`
        : `limited by memory (${cap.memoryMb} MB): give Docker more memory for more`;
  return { slots, limitedBy, text: `${slots} ${slots === 1 ? "slot" : "slots"}, ${why}` };
}

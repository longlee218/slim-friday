import type { Activity, RunStep } from "@friday/core";
import { z } from "zod";
import type { AgentConfig } from "../config/agent-config";

/** What a hint names: a new run, an answered card, steering, a cancel, or a config change. */
export const HINT_KINDS = ["run", "card", "steer", "cancel", "config"] as const;
export type HintKind = (typeof HINT_KINDS)[number];

/**
 * A hint between processes: rows were written, a worker should look now. `ids` are run ids (`run`, `steer`,
 * `cancel`) or card ids (`card`). Main broadcasts every hint to every worker; a worker sends its own hints
 * (a run it created: bot send, continuation, result) to main, which broadcasts them.
 */
export type HintMessage = { t: "hint"; kind: HintKind; ids?: string[] };

/** Main to worker: the start values (sent once, first), then hints. */
export type MainToWorker =
  | {
      t: "init";
      config: AgentConfig;
      /** The OAuth MCP proxy in main (port and key secret), when there is one. */
      mcpProxy?: { port: number; secret: string };
    }
  | HintMessage;

/**
 * Worker to main. `ready`: composed and claiming. `post`: a message is stored (main reads it by id and
 * publishes it). `activity` / `run_step` / `finished`: live only. `card`: a card row changed (main shows or closes it from
 * the row). `ticket`: a ticket was saved (main reads it by id and tells the web). `schedule`: a bot changed a
 * schedule (main kicks its ticker and tells the web). `hint`: rows this worker wrote.
 */
export type WorkerToMain =
  | { t: "ready" }
  | { t: "post"; messageId: number; conversationId: string }
  | { t: "activity"; conversationId: string; activity: Activity }
  | { t: "run_step"; conversationId: string; botId: string; step: RunStep }
  | { t: "finished"; conversationId: string; botId: string; preview: string }
  | { t: "card"; cardId: string }
  | { t: "ticket"; ticketId: string }
  | { t: "schedule"; scheduleId: string }
  | HintMessage;

/** Shape check of a hint. */
const hintSchema = z.strictObject({
  t: z.literal("hint"),
  kind: z.enum(HINT_KINDS),
  ids: z.array(z.string()).optional(),
});

/** Shape check of the start values (the config itself was validated by main's `loadConfig`). */
const initSchema = z.strictObject({
  t: z.literal("init"),
  config: z.looseObject({ agentHome: z.string().min(1), r2: z.looseObject({}) }),
  mcpProxy: z
    .strictObject({ port: z.number().int().min(1).max(65535), secret: z.string().min(1) })
    .optional(),
});

/** Shape check of a live activity. */
const activitySchema = z.strictObject({
  kind: z.enum(["typing", "subagent"]),
  botId: z.string(),
  label: z.string().optional(),
});

/** Shape check of a run step (only the fields the web needs are required). */
const stepSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  label: z.string(),
  state: z.enum(["running", "done", "failed"]),
  startedAt: z.number(),
});

/** Every message a worker may send. */
const workerSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("ready") }),
  z.strictObject({ t: z.literal("post"), messageId: z.number().int(), conversationId: z.string() }),
  z.strictObject({
    t: z.literal("activity"),
    conversationId: z.string(),
    activity: activitySchema,
  }),
  z.strictObject({
    t: z.literal("run_step"),
    conversationId: z.string(),
    botId: z.string(),
    step: stepSchema,
  }),
  z.strictObject({
    t: z.literal("finished"),
    conversationId: z.string(),
    botId: z.string(),
    preview: z.string(),
  }),
  z.strictObject({ t: z.literal("card"), cardId: z.string() }),
  z.strictObject({ t: z.literal("ticket"), ticketId: z.string() }),
  z.strictObject({ t: z.literal("schedule"), scheduleId: z.string().min(1) }),
  hintSchema,
]);

/** Every message main may send. */
const mainSchema = z.discriminatedUnion("t", [initSchema, hintSchema]);

/** A message from a worker, or undefined when it is not one of the known shapes. */
export function parseWorkerToMain(m: unknown): WorkerToMain | undefined {
  const r = workerSchema.safeParse(m);
  return r.success ? (r.data as WorkerToMain) : undefined;
}

/** A message from main, or undefined when it is not one of the known shapes. */
export function parseMainToWorker(m: unknown): MainToWorker | undefined {
  const r = mainSchema.safeParse(m);
  return r.success ? (r.data as MainToWorker) : undefined;
}

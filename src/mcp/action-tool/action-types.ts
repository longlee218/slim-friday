import type { z } from "zod";
import type { Reply } from "../../effects/reply";

/**
 * One action of an action tool: its name (a constant), its own params schema, one example call and the handler.
 * `C` is what the tool's handlers need (a ctx part such as the teammate ctx); `P` is the parsed params type.
 */
export interface ActionDef<C = unknown, P = never> {
  /** Action name (from the tool's `action-names.ts`). */
  name: string;
  /** Zod object of the action's params; checked inside the tool handler, never put in the tool definition. */
  schema: z.ZodType<P>;
  /** A valid `params` object, returned with `BAD_PARAMS` so one retry fixes the call. */
  example: Record<string, unknown>;
  /** Runs the action with the parsed params; an existing handler is bound here as is (no new logic). */
  run(ctx: C, params: P): Reply | Promise<Reply>;
}

/** Actions of different param types in one table (each keeps its own `P` inside `defineAction`). */
// biome-ignore lint/suspicious/noExplicitAny: a table mixes actions whose param types differ
export type AnyAction<C> = ActionDef<C, any>;

/** Binds an action: the param type is inferred from the shape, the ctx type from the handler. */
export function defineAction<C, S extends z.ZodRawShape>(def: {
  name: string;
  schema: z.ZodObject<S>;
  example: Record<string, unknown>;
  run: (ctx: C, params: z.output<z.ZodObject<S>>) => Reply | Promise<Reply>;
}): AnyAction<C> {
  return def;
}

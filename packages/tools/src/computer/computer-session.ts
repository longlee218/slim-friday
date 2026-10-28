import {
  acquireSlot,
  ComputerBusyError,
  type ComputerHold,
  ComputerOwnerControlError,
  releaseSlot,
  renewSlot,
  withInputLease,
} from "@friday/core";
import type { textResult } from "../tool-result";
import { textResult as makeText } from "../tool-result";
import type { ComputerContext } from "./computer-context";
import { slotHeartbeat } from "./slot-heartbeat";

/** Most steps or actions one act call runs. */
export const MAX_BATCH = 20;

/** Refusal text when the slot expired between two tool calls. */
const SLOT_LOST = "computer slot was lost; the bot must call the tool again to re-acquire";

/** Refusal text while the owner holds the input lease. */
const OWNER_CONTROL =
  "the owner is controlling this computer; end this turn and say you will continue when they give it back";

/** What a tool handler returns: a text result or one with an image block. */
export type ToolResult = ReturnType<typeof textResult> | { content: unknown[]; isError?: true };

/** Per-session state of the computer tools: the slot hold lives here, in a closure of `computerServer`. */
export interface ComputerSession {
  ctx: ComputerContext;
  /** Ensure the slot and the machine, then run `fn`; any failure becomes an error result. */
  run(fn: () => Promise<ToolResult>): Promise<ToolResult>;
  /** Same as `run`, inside the exclusive input lease; `check` renews it and throws when it was lost. */
  runLeased(fn: (check: () => Promise<void>) => Promise<ToolResult>): Promise<ToolResult>;
  /** PNG of the previous screenshot in this session. */
  lastPng: Uint8Array | undefined;
}

/** Build the session state for one `computer` server. */
export function createComputerSession(ctx: ComputerContext): ComputerSession {
  const deps = { holds: ctx.holds, clock: ctx.clock, sleep: ctx.sleep };
  let hold: ComputerHold | undefined;
  const beat = slotHeartbeat(deps, ctx.every, async () => {
    // Idle: close Chromium (the profile keeps logins) and free the slot; the next call re-acquires via `start`.
    const idle = hold;
    hold = undefined;
    await ctx.browser.close().catch(() => undefined);
    if (idle) await releaseSlot(deps, idle).catch(() => undefined);
  });

  /** The first start in flight; parallel first callers share it, so the machine and browser start once. */
  let starting: Promise<ComputerHold> | undefined;

  /** Take a slot and start the machine and browser; releases the slot again when the start fails. */
  const start = async (): Promise<ComputerHold> => {
    // The slot count may still be in the making at boot (or retried after a failed count): wait for it.
    await ctx.slotsReady?.();
    const taken = await acquireSlot(deps, {
      computer: ctx.computer.name,
      botId: ctx.botId,
      holder: ctx.holder,
      slotLimit: ctx.slotLimit(),
      slotsText: ctx.slotsText(),
    });
    try {
      await ctx.provider.ensure(ctx.computer);
      await ctx.browser.ensure();
    } catch (err) {
      await releaseSlot(deps, taken).catch(() => undefined);
      throw err;
    }
    return taken;
  };

  /** First call: start (shared by parallel callers). Later calls: renew the slot. */
  const ensureSession = async (): Promise<void> => {
    if (hold) {
      if (await renewSlot(deps, hold)) return;
      hold = undefined;
      beat.stop();
      throw new ComputerBusyError(SLOT_LOST);
    }
    if (!starting) {
      const p = start();
      starting = p;
      p.then(
        (h) => {
          hold = h;
          starting = undefined;
          beat.start(h);
        },
        () => {
          starting = undefined;
        },
      );
    }
    await starting;
  };

  const run = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      beat.touch();
      await ensureSession();
      return await fn();
    } catch (err) {
      if (err instanceof ComputerOwnerControlError) {
        ctx.onOwnerBlocked?.(ctx.botId, ctx.computer.name);
        return makeText(OWNER_CONTROL, true);
      }
      return makeText(err instanceof Error ? err.message : String(err), true);
    }
  };

  return {
    ctx,
    lastPng: undefined,
    run,
    runLeased: (fn) =>
      run(() =>
        withInputLease(
          deps,
          { computer: ctx.computer.name, botId: ctx.botId, holder: ctx.holder },
          fn,
        ),
      ),
  };
}

/** A readable refusal when a batch is empty or longer than `MAX_BATCH`; undefined when it fits. */
export function batchError(what: string, n: number): string | undefined {
  return n >= 1 && n <= MAX_BATCH
    ? undefined
    : `${what} must hold 1 to ${MAX_BATCH} entries; got ${n}.`;
}

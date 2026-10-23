import type { Database } from "bun:sqlite";
import { clip } from "../observability/redact";
import { type Reply, refuse } from "../orchestrator/reply";
import { appendEffect } from "../storage/effect-log-store";
import type { DispatchEnvelope } from "./envelope";
import { realOrSame } from "./paths";

/* What the four effect tools need of the run they serve (built per worker run, never shared). */

/** Runs `git` / `gh` (an argv array, never a shell line) in a dir. Tests inject a fake. */
export type Runner = (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>;

/** A registered location of the workspace. */
interface EffectLocation {
  name: string;
  path: string;
}

/** Context of the effect tools of one worker run. */
export interface EffectsCtx {
  db: Database;
  threadId: string;
  goalId: string;
  itemId: string;
  envelope: DispatchEnvelope;
  /** A teammate run: the envelope grants nothing by itself, so every act asks the owner once (yes / no, fail closed). */
  ownerPerAct?: boolean;
  /** Every location of the workspace (an act on one outside the envelope is R4, not a plain refusal). */
  locations: EffectLocation[];
  agentHome: string;
  /** Yes / no to the owner (fail closed: no flow, timeout or stop = false). */
  confirm(summary: string): Promise<boolean>;
  run: Runner;
  now?: () => number;
}

/** Real path of a location by name, or undefined. */
export const locationPath = (ctx: EffectsCtx, name: string): string | undefined => {
  const hit = ctx.locations.find((l) => l.name === name);
  return hit ? realOrSame(hit.path) : undefined;
};

/** Append the audit row of one effect (`granted` = who allowed it: the envelope's, or `owner` after a question). */
export function recordEffect(
  ctx: EffectsCtx,
  e: {
    tool: string;
    scope: string;
    result: string;
    undo?: string;
    owner?: boolean;
  },
): void {
  appendEffect(ctx.db, {
    id: crypto.randomUUID(),
    threadId: ctx.threadId,
    goalId: ctx.goalId,
    itemId: ctx.itemId,
    tool: e.tool,
    scope: e.scope,
    grantedBy: e.owner ? "owner" : ctx.envelope.grantedBy,
    result: e.result,
    ...(e.undo && { undo: e.undo }),
  });
}

/**
 * Owner-per-act runs only: ask the owner before the act, unless a stricter question was already asked (`asked`). Returns the
 * refusal (written to the audit) when the owner says no or does not answer, undefined to go on.
 */
export async function askOwnerPerAct(
  ctx: EffectsCtx,
  e: { tool: string; scope: string; summary: string; asked?: boolean },
): Promise<Reply | undefined> {
  if (!ctx.ownerPerAct || e.asked) return undefined;
  if (await ctx.confirm(e.summary)) return undefined;
  return refuseLogged(
    ctx,
    e.tool,
    e.scope,
    "OWNER_DENIED",
    "The owner did not allow this act.",
    "denied",
  );
}

/** Control, line-break, bidi and zero-width characters: they could forge lines in an owner question. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const SPOOF = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/** Text for an owner question or an audit scope: spoofing characters shown escaped (`\u000a`), never raw. */
export const safeText = (s: string): string =>
  s.replace(SPOOF, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/**
 * Refuse a call AND write its audit row (`result` = refused, or denied for an owner's no, plus the code): a refusal is
 * evidence too. Returns the refusal reply.
 */
export function refuseLogged(
  ctx: EffectsCtx,
  tool: string,
  scope: string,
  code: string,
  message: string,
  result: "refused" | "denied" = "refused",
): Reply {
  recordEffect(ctx, {
    tool,
    scope: clip(safeText(scope), 500),
    result: JSON.stringify({ result, code }),
  });
  return refuse(code, message);
}

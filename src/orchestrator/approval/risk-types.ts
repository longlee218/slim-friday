import type { EFFECT_TOOL_NAMES } from "../../mcp/effects/effect-tool-names";
import type { Risk } from "../plan/plan-types";

/* Shared words of the approval policy (R0-R4). Pure types and constants: no db, no fs. */

/** Risk class of one action. R4 (forbidden to automate) is never planned or granted: it asks every time. */
export type RiskClass = Risk | "R4";

/** The four effect tools, the only way to do R2/R3 work. */
export type EffectTool = (typeof EFFECT_TOOL_NAMES)[number];

/** Order of the classes, low to high (`maxRisk`, envelope checks). */
const ORDER: readonly RiskClass[] = ["R0", "R1", "R2", "R3", "R4"];

/** The higher of two classes. */
export const maxRisk = (a: RiskClass, b: RiskClass): RiskClass =>
  ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;

/** Default bound of one goal's deferred scope (brainstorm 5.14): items and bytes moved to the trash. */
export const DEFAULT_BOUNDS = { maxItems: 200, maxBytes: 50 * 1024 ** 3 } as const;

/** Days a trashed path is kept before the sweeper removes it. */
const TRASH_DAYS = 7;
/** Milliseconds of `TRASH_DAYS`. */
export const TRASH_TTL_MS = TRASH_DAYS * 86_400_000;

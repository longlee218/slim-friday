import { z } from "zod";
import type { Effort, TaskClass } from "../config/model-routing";

/** Closed value sets, typed against the routing config so a rename there breaks here at compile time. */
const EFFORTS = ["low", "medium", "high", "max"] as const satisfies readonly Effort[];
const CLASSES = ["mechanical", "standard", "design"] as const satisfies readonly TaskClass[];

/** What a fired group does to the effort decision (all optional; the lexicon never routes). */
const effectSchema = z
  .object({
    /** Thread effort floor +N (complaints). The strongest group wins, deltas of groups do not add up. */
    floorDelta: z.number().int().min(0).max(2).optional(),
    /** This turn +/-N. Groups add up (clamped by the signal code). */
    turnDelta: z.number().int().min(-2).max(2).optional(),
    /** Effort at least this. */
    minEffort: z.enum(EFFORTS).optional(),
    /** Hint for the task class (design). */
    classHint: z.enum(CLASSES).optional(),
    /** Enable web lookup. */
    lookup: z.boolean().optional(),
  })
  .strict();

/** One signal group: phrases fire alone, `weak` words only in pairs. Group key = rule id in logs. */
const groupSchema = z
  .object({
    effect: effectSchema,
    phrases: z.array(z.string().min(1)).min(1),
    weak: z.array(z.string().min(1)).optional(),
  })
  .strict();

/** Lexicon file: `groups:` keyed by rule id (lower snake case). Adding a group is a data-only change. */
export const lexiconFileSchema = z
  .object({
    groups: z.record(
      z.string().regex(/^[a-z][a-z0-9_]*$/, "group key must be lower_snake_case"),
      groupSchema,
    ),
  })
  .strict();

export type GroupEffect = z.infer<typeof effectSchema>;

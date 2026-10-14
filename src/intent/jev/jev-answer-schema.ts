import { z } from "zod";

const prob = z.number().min(0).max(1);

/** Answers the app reads (extra ids are ignored). `role` is a Choice, the rest are Noul (P(yes)). */
const answersSchema = z.object({
  role: z.object({
    choice: z.string(),
    probabilities: z.record(z.string(), prob),
    confidence: prob,
  }),
  multi_intent: z.object({ noul: prob }),
  continues_task: z.object({ noul: prob }).optional(),
  asks_about_task: z.object({ noul: prob }).optional(),
  fits_last_role: z.object({ noul: prob }).optional(),
});

export type JevAnswers = z.infer<typeof answersSchema>;

/**
 * Validate the raw answers. `options` = the option names sent in the `role` question: a pick or probability outside
 * them is an invalid answer (the output may only select known names). Returns undefined when invalid.
 */
export function parseJevAnswers(
  raw: unknown,
  options: ReadonlySet<string>,
): JevAnswers | undefined {
  const r = answersSchema.safeParse(raw);
  if (!r.success) return undefined;
  const { choice, probabilities } = r.data.role;
  if (!options.has(choice) || Object.keys(probabilities).some((k) => !options.has(k)))
    return undefined;
  return r.data;
}

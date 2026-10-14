import { z } from "zod";

/** Minimal schema of the legacy `repo.yaml`. Only `path` and `description` survive the migration. */
export const legacyRepoSchema = z.object({
  path: z.string().optional(),
  description: z.string().default(""),
  defaultBranch: z.string().optional(),
  testCommand: z.string().optional(),
  githubAccount: z.string().optional(),
  gitAuthor: z.unknown().optional(),
  workflow: z.unknown().optional(),
});

/** Legacy fields that are dropped (owner answer 2): printed in the report, never written anywhere. */
export const DROPPED_FIELDS = [
  "defaultBranch",
  "testCommand",
  "githubAccount",
  "gitAuthor",
  "workflow",
] as const;

/** Parsed legacy `repo.yaml`. */
export type LegacyRepo = z.infer<typeof legacyRepoSchema>;

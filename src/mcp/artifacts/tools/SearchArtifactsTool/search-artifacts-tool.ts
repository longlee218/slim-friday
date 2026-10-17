import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type ArtifactToolCtx, searchChannel } from "../../../../artifacts/artifact-access";
import {
  ARTIFACT_SEARCH_DEFAULT_LIMIT,
  ARTIFACT_SEARCH_MAX_LIMIT,
} from "../../../../artifacts/artifact-limits";
import { runTool } from "../../../tool-result";
import { SEARCH_ARTIFACTS_TOOL } from "./constants";
import { SEARCH_ARTIFACTS_DESCRIPTION } from "./prompt";

const SHAPE = {
  query: z.string().min(1).describe("Keywords (any language; accents optional)."),
  goalId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("YYYY-MM-DD: only artifacts from this day on."),
  limit: z
    .number()
    .int()
    .optional()
    .describe(`Default ${ARTIFACT_SEARCH_DEFAULT_LIMIT}, max ${ARTIFACT_SEARCH_MAX_LIMIT}.`),
};

/** The `SearchArtifacts` tool of ONE run (read-only; only its own channel). */
export function createSearchArtifactsTool(ctx: ArtifactToolCtx) {
  return tool(SEARCH_ARTIFACTS_TOOL, SEARCH_ARTIFACTS_DESCRIPTION, SHAPE, (args) =>
    runTool(SEARCH_ARTIFACTS_TOOL, async () => searchChannel(ctx, args)),
  );
}

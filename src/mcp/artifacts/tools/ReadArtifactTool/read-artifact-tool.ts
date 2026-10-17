import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type ArtifactToolCtx, readArtifact } from "../../../../artifacts/artifact-access";
import { ARTIFACT_READ_PAGE_CHARS } from "../../../../artifacts/artifact-limits";
import { runTool } from "../../../tool-result";
import { READ_ARTIFACT_TOOL } from "./constants";
import { READ_ARTIFACT_DESCRIPTION } from "./prompt";

const SHAPE = {
  id: z.string().min(1),
  offset: z.number().int().min(0).optional().describe("Char to start at (default 0)."),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`Chars of this page (default and max ${ARTIFACT_READ_PAGE_CHARS}).`),
};

/** The `ReadArtifact` tool of ONE run (read-only; the channel scope is checked on every call). */
export function createReadArtifactTool(ctx: ArtifactToolCtx) {
  return tool(READ_ARTIFACT_TOOL, READ_ARTIFACT_DESCRIPTION, SHAPE, (args) =>
    runTool(READ_ARTIFACT_TOOL, async () => readArtifact(ctx, args.id, args.offset, args.limit)),
  );
}

import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type ArtifactToolCtx, saveArtifact } from "../../../../artifacts/artifact-access";
import { ARTIFACT_KINDS } from "../../../../artifacts/artifact-kinds";
import { runTool } from "../../../tool-result";
import { SAVE_ARTIFACT_TOOL } from "./constants";
import { SAVE_ARTIFACT_DESCRIPTION } from "./prompt";

/** Input: no cap on `body` (the owner decided). */
const SHAPE = {
  title: z.string().min(1),
  kind: z.enum(ARTIFACT_KINDS),
  body: z.string().min(1),
};

/** The `SaveArtifact` tool of ONE run: writes through the artifact writer in code (the run's disk access is not widened). */
export function createSaveArtifactTool(ctx: ArtifactToolCtx) {
  return tool(SAVE_ARTIFACT_TOOL, SAVE_ARTIFACT_DESCRIPTION, SHAPE, (args) =>
    runTool(SAVE_ARTIFACT_TOOL, async () => saveArtifact(ctx, args)),
  );
}

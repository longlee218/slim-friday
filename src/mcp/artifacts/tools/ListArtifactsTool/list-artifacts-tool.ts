import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { type ArtifactToolCtx, listArtifacts } from "../../../../artifacts/artifact-access";
import { runTool } from "../../../tool-result";
import { LIST_ARTIFACTS_TOOL } from "./constants";
import { LIST_ARTIFACTS_DESCRIPTION } from "./prompt";

const SHAPE = { goalId: z.string().min(1).optional(), threadId: z.string().min(1).optional() };

/** The `ListArtifacts` tool of ONE run (read-only; only its own channel). */
export function createListArtifactsTool(ctx: ArtifactToolCtx) {
  return tool(LIST_ARTIFACTS_TOOL, LIST_ARTIFACTS_DESCRIPTION, SHAPE, (args) =>
    runTool(LIST_ARTIFACTS_TOOL, async () => listArtifacts(ctx, args)),
  );
}

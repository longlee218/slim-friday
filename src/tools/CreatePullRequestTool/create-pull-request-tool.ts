import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CREATE_PULL_REQUEST_TOOL } from "../../mcp/mcp-tool-names";
import type { EffectsCtx } from "../../orchestrator/approval/effect-context";
import { createPullRequest } from "../../orchestrator/approval/pull-request";
import { runTool } from "../lead-tool-result";
import { BODY_MAX_CHARS, NAME_MAX_CHARS, TITLE_MAX_CHARS } from "./constants";
import { CREATE_PULL_REQUEST_DESCRIPTION } from "./prompt";

const SHAPE = {
  location: z.string().min(1).max(NAME_MAX_CHARS),
  base: z.string().min(1).max(NAME_MAX_CHARS),
  head: z.string().min(1).max(NAME_MAX_CHARS),
  title: z.string().min(1).max(TITLE_MAX_CHARS),
  body: z.string().max(BODY_MAX_CHARS),
};

/** The `CreatePullRequest` tool: strict schema + error wrapper around `createPullRequest`. */
export function createCreatePullRequestTool(ctx: EffectsCtx) {
  return tool(CREATE_PULL_REQUEST_TOOL, CREATE_PULL_REQUEST_DESCRIPTION, SHAPE, (args) =>
    runTool(CREATE_PULL_REQUEST_TOOL, () => createPullRequest(ctx, args)),
  );
}

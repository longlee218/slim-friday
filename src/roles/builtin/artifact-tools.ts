import { LIST_ARTIFACTS_TOOL } from "../../mcp/artifacts/tools/ListArtifactsTool/constants";
import { READ_ARTIFACT_TOOL } from "../../mcp/artifacts/tools/ReadArtifactTool/constants";
import { SAVE_ARTIFACT_TOOL } from "../../mcp/artifacts/tools/SaveArtifactTool/constants";
import { SEARCH_ARTIFACTS_TOOL } from "../../mcp/artifacts/tools/SearchArtifactsTool/constants";

/**
 * The `artifacts` server tools every role with a channel scope lists (lead, scout, planner, developer, roster
 * specialists): list, read and search the channel's artifacts, and save one. Saving writes through code under AGENT_HOME,
 * so a read-only worker stays read-only on disk.
 */
export const ARTIFACT_TOOLS = [
  SAVE_ARTIFACT_TOOL,
  READ_ARTIFACT_TOOL,
  LIST_ARTIFACTS_TOOL,
  SEARCH_ARTIFACTS_TOOL,
] as const;

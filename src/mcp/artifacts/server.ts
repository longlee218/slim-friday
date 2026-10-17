import type { McpServerManifest } from "../manifest-types";
import { ARTIFACTS_MCP_SERVER } from "../mcp-tool-names";
import { LIST_ARTIFACTS_TOOL } from "./tools/ListArtifactsTool/constants";
import { createListArtifactsTool } from "./tools/ListArtifactsTool/list-artifacts-tool";
import { READ_ARTIFACT_TOOL } from "./tools/ReadArtifactTool/constants";
import { createReadArtifactTool } from "./tools/ReadArtifactTool/read-artifact-tool";
import { SAVE_ARTIFACT_TOOL } from "./tools/SaveArtifactTool/constants";
import { createSaveArtifactTool } from "./tools/SaveArtifactTool/save-artifact-tool";
import { SEARCH_ARTIFACTS_TOOL } from "./tools/SearchArtifactsTool/constants";
import { createSearchArtifactsTool } from "./tools/SearchArtifactsTool/search-artifacts-tool";

/**
 * The `artifacts` server: every artifact tool, one server by purpose. A run holds the ones in its `role.mcpTools` when it
 * has an `artifacts` ctx part (its channel scope); no part, no tool.
 */
export const ARTIFACTS_SERVER: McpServerManifest = {
  name: ARTIFACTS_MCP_SERVER,
  tools: [
    { name: SAVE_ARTIFACT_TOOL, create: (c) => c.artifacts && createSaveArtifactTool(c.artifacts) },
    { name: READ_ARTIFACT_TOOL, create: (c) => c.artifacts && createReadArtifactTool(c.artifacts) },
    {
      name: LIST_ARTIFACTS_TOOL,
      create: (c) => c.artifacts && createListArtifactsTool(c.artifacts),
    },
    {
      name: SEARCH_ARTIFACTS_TOOL,
      create: (c) => c.artifacts && createSearchArtifactsTool(c.artifacts),
    },
  ],
};

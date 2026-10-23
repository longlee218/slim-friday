import { LIST_ARTIFACTS_TOOL } from "./tools/ListArtifactsTool/constants";
import { READ_ARTIFACT_TOOL } from "./tools/ReadArtifactTool/constants";
import { SAVE_ARTIFACT_TOOL } from "./tools/SaveArtifactTool/constants";
import { SEARCH_ARTIFACTS_TOOL } from "./tools/SearchArtifactsTool/constants";

/**
 * The `artifacts` server tools every role with a channel scope lists (lead, scout, researcher, developer, roster
 * specialists): list, read and search the channel's artifacts. Read-only: a worker's files reach the owner through
 * `Report result` `files` and the lead's `forward`.
 */
export const ARTIFACT_READ_TOOLS = [
  READ_ARTIFACT_TOOL,
  LIST_ARTIFACTS_TOOL,
  SEARCH_ARTIFACTS_TOOL,
] as const;

/** The lead's artifact tools: the read tools and `SaveArtifact` (only the lead makes artifacts of its own; code makes the others at `forward`). */
export const ARTIFACT_TOOLS = [SAVE_ARTIFACT_TOOL, ...ARTIFACT_READ_TOOLS] as const;

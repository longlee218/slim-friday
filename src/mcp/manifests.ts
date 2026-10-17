import { DISCORD_ADMIN_SERVER } from "./discord-admin/server";
import { EFFECTS_SERVER } from "./effects/server";
import { FIRECRAWL_SERVER } from "./firecrawl/server";
import type { ExternalMcpServer, McpServerManifest } from "./manifest-types";
import { MEMORY_SERVER } from "./memory/server";
import { ORCHESTRATION_SERVER } from "./orchestration/server";
import { PLAN_SERVER } from "./plan/server";

/**
 * Every in-process MCP server of the app. A new tool = one folder + one line in its server manifest + a role
 * `mcpTools` entry. The guard's allow list and the per-run build both derive from this list.
 */
export const ALL_SERVERS: readonly McpServerManifest[] = [
  MEMORY_SERVER,
  ORCHESTRATION_SERVER,
  PLAN_SERVER,
  EFFECTS_SERVER,
  DISCORD_ADMIN_SERVER,
];

/** Every external (hosted) MCP server the app may connect a run to. Same rule: a role gets one only through `mcpTools`. */
export const EXTERNAL_SERVERS: readonly ExternalMcpServer[] = [FIRECRAWL_SERVER];

import { PLACEHOLDER } from "./agent-config";
import { readProcessEnv } from "./process-env";

/** Hosted Firecrawl MCP endpoint (Streamable HTTP). The key travels in a header, never in the URL. */
export const FIRECRAWL_MCP_URL = "https://mcp.firecrawl.dev/v2/mcp";

/**
 * The owner's Firecrawl API key (`FIRECRAWL_API_KEY`), trimmed; undefined when unset or the placeholder. Read live, so
 * the Firecrawl server is simply not built without a key. The key is denied to every agent child process
 * (`data/child-env-deny.yaml`): only the SDK's own MCP client sends it.
 */
export function firecrawlApiKey(): string | undefined {
  const key = readProcessEnv().FIRECRAWL_API_KEY?.trim();
  return key && key !== PLACEHOLDER ? key : undefined;
}

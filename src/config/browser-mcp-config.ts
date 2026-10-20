import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

/** Shape of `data/browser-mcp.yaml`: the npm package, its pinned exact version and the server's env. */
interface BrowserMcpData {
  package: string;
  version: string;
  env: Record<string, string>;
}

/** The pinned browser server (data: a version bump is a data change plus a review). */
const DATA = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "data", "browser-mcp.yaml"), "utf8"),
) as BrowserMcpData;

/** `<package>@<exact version>`, as `npx` gets it. */
export const BROWSER_MCP_PACKAGE = `${DATA.package}@${DATA.version}`;

/** Sub dir of the run's scratch dir that holds the browser's profile (one fresh profile per run). */
const PROFILE_DIR = "browser-profile";

/**
 * SDK config of the local browser MCP server of one run: `npx` starts the pinned package as a stdio child of the CLI
 * (the CLI's own env, scrubbed for a worker, plus the data file's env). The CLI does not put an MCP server in the Bash
 * OS sandbox (source reading, not verified live), so the bounds are the server's own flags:
 * - headless Chrome with a fresh profile inside the run's scratch dir (`--userDataDir`), never the owner's profile;
 * - file tools (screenshot or snapshot `filePath`, Lighthouse reports) only inside the scratch dir (`--workspace`);
 * - `file:` URLs blocked (`--blockedUrlPattern`; the guard also refuses a non-web URL in a navigate or new-page call);
 * - no CrUX lookups, no usage statistics, no performance-trace tools (not in any role's list).
 */
export function browserMcpConfig(scratchDir: string): McpStdioServerConfig {
  return {
    type: "stdio",
    command: "npx",
    args: [
      "-y",
      BROWSER_MCP_PACKAGE,
      "--headless",
      `--userDataDir=${join(scratchDir, PROFILE_DIR)}`,
      `--workspace=${scratchDir}`,
      "--blockedUrlPattern=file:*",
      "--no-usage-statistics",
      "--no-performance-crux",
      "--no-category-performance",
    ],
    env: { ...DATA.env },
  };
}

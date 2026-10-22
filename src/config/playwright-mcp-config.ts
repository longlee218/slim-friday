import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";

/** Shape of `data/playwright-mcp.yaml`: the npm package and its pinned exact version. */
interface PlaywrightMcpData {
  package: string;
  version: string;
}

/** The pinned Playwright server (data: a version bump is a data change plus a review). */
const DATA = Bun.YAML.parse(
  readFileSync(join(import.meta.dir, "data", "playwright-mcp.yaml"), "utf8"),
) as PlaywrightMcpData;

/** `<package>@<exact version>`, as `npx` gets it. */
export const PLAYWRIGHT_MCP_PACKAGE = `${DATA.package}@${DATA.version}`;

/**
 * SDK config of the local Playwright MCP server of one run: `npx` starts the pinned package as a stdio child of the CLI
 * (live probe 2026-10-21: it connects with the SDK sandbox on, in about 1-6 s; the SDK sandbox bounds Bash only, so this child runs outside it, as the owner, with the scrubbed worker env; `browser_run_code_unsafe` is therefore a filesystem escape, unconfirmed against 0.0.83). Bounds are the server's own flags:
 * - headless chromium with `--isolated` (an in-memory profile per run: no login, nothing stored, never the owner's profile);
 * - snapshots and screenshots are written to the run's scratch dir (`--output-dir`), where `Report result images` reads them.
 */
export function playwrightMcpConfig(scratchDir: string): McpStdioServerConfig {
  return {
    type: "stdio",
    command: "npx",
    args: [
      "-y",
      PLAYWRIGHT_MCP_PACKAGE,
      "--headless",
      "--isolated",
      "--browser",
      "chromium",
      "--output-dir",
      scratchDir,
    ],
  };
}

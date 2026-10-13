import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { reindexFile } from "../memory/index/memory-index";
import { safely } from "../memory/index/safely";
import { createMemoryExpandTool } from "../tools/MemoryExpandTool/memory-expand-tool";
import { createMemoryGetTool } from "../tools/MemoryGetTool/memory-get-tool";
import { createMemorySearchTool } from "../tools/MemorySearchTool/memory-search-tool";
import { createReadBudget } from "../tools/memory-read-shared";
import type { MemoryToolContext } from "../tools/memory-tool-context";
import { createRememberTool } from "../tools/RememberTool/remember-tool";
import { MEMORY_MCP_SERVER } from "./mcp-tool-names";

/**
 * The in-process `memory` server of ONE run (SDK MCP server: runs in the app process, no stdio child).
 * `Remember` writes (and re-indexes the file it touched at once); Search/Get/Expand only read and share one
 * per-run call cap. New memory tools are added here AND to `MEMORY_TOOLS`, which the guard reads.
 */
export function createMemoryServer(ctx: MemoryToolContext) {
  const budget = createReadBudget();
  const withIndex: MemoryToolContext = {
    ...ctx,
    onSaved: (file) => {
      safely("reindex", () => reindexFile(ctx.db, ctx.home, file));
      ctx.onSaved?.(file);
    },
  };
  return createSdkMcpServer({
    name: MEMORY_MCP_SERVER,
    tools: [
      createRememberTool(withIndex),
      createMemorySearchTool(ctx, budget),
      createMemoryGetTool(ctx, budget),
      createMemoryExpandTool(ctx, budget),
    ],
  });
}

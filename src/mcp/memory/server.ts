import { reindexFile } from "../../memory/index/memory-index";
import { safely } from "../../memory/index/safely";
import type { McpServerManifest } from "../manifest-types";
import { MEMORY_MCP_SERVER } from "../mcp-tool-names";
import { createReadBudget } from "./memory-read-shared";
import { MEMORY_EXPAND_TOOL } from "./tools/MemoryExpandTool/constants";
import { createMemoryExpandTool } from "./tools/MemoryExpandTool/memory-expand-tool";
import { MEMORY_GET_TOOL } from "./tools/MemoryGetTool/constants";
import { createMemoryGetTool } from "./tools/MemoryGetTool/memory-get-tool";
import { MEMORY_SEARCH_TOOL } from "./tools/MemorySearchTool/constants";
import { createMemorySearchTool } from "./tools/MemorySearchTool/memory-search-tool";
import { REMEMBER_TOOL } from "./tools/RememberTool/constants";
import { createRememberTool } from "./tools/RememberTool/remember-tool";

/**
 * The `memory` server: `Remember` writes (and re-indexes the file it touched at once); Search / Get / Expand only read
 * and share one per-instance call cap (created in `prepare`, so every built server has its own).
 */
export const MEMORY_SERVER: McpServerManifest = {
  name: MEMORY_MCP_SERVER,
  prepare: (ctx) =>
    ctx.memory
      ? {
          ...ctx,
          readBudget: createReadBudget(),
          memory: {
            ...ctx.memory,
            // A saved file is re-indexed for MemorySearch before the caller's own hook runs.
            onSaved: (file) => {
              const m = ctx.memory;
              if (!m) return;
              safely("reindex", () => reindexFile(m.db, m.home, file));
              m.onSaved?.(file);
            },
          },
        }
      : ctx,
  tools: [
    {
      name: REMEMBER_TOOL,
      create: (c) => c.memory && createRememberTool(c.memory),
    },
    {
      name: MEMORY_SEARCH_TOOL,
      create: (c) => c.memory && c.readBudget && createMemorySearchTool(c.memory, c.readBudget),
    },
    {
      name: MEMORY_GET_TOOL,
      create: (c) => c.memory && c.readBudget && createMemoryGetTool(c.memory, c.readBudget),
    },
    {
      name: MEMORY_EXPAND_TOOL,
      create: (c) => c.memory && c.readBudget && createMemoryExpandTool(c.memory, c.readBudget),
    },
  ],
};

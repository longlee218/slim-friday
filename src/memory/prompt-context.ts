import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent, logger } from "../observability/logger";
import { buildPersonaContext } from "./persona";
import { buildMemoryContext, readRootMemory } from "./repo-memory";

/** Logger of this module (task fields come from the log context). */
const log = logger.child({ module: "prompt-context" });

/** What a flow knows when it builds the context of one run. */
export interface PromptContextInput {
  agentHome: string;
  /** Pinned workspace: its persona files override the root ones. Undefined = root files only. */
  workspace?: string;
  /** Registry block (qa unpinned, plan). */
  registry?: string;
  /** Exec only: CLAUDE.md of the trusted clone (settingSources is [] there). */
  repoClaudeMd?: string;
  /** Workspaces whose memory is added after the root memory. */
  memoryWorkspaces: string[];
  /** qa/plan cwd: its CLAUDE.md is auto-loaded by the SDK; measured for the size log only. */
  sdkCwd?: string;
}

/**
 * The one place that orders the prompt context of a run:
 * AGENTS, IDENTITY, SOUL, USER -> registry -> repo CLAUDE.md (exec) -> memory (root, workspaces).
 * Logs one `prompt.context` event with the chars of each layer (counts only, never content).
 * BOOTSTRAP.md is an owner guide and is never injected.
 */
export function buildPromptContext(i: PromptContextInput): string[] {
  const persona = buildPersonaContext(i.agentHome, i.workspace);
  const registry = i.registry ?? "";
  const claudeMd = i.repoClaudeMd ?? "";
  const memory = buildMemoryContext(i.agentHome, i.memoryWorkspaces);
  const blocks = [persona.text, registry, claudeMd, memory];
  const sdkFile = i.sdkCwd ? join(i.sdkCwd, "CLAUDE.md") : "";
  const rootChars = readRootMemory(i.agentHome).length;
  logEvent(
    log,
    "prompt.context",
    {
      personaChars: persona.text.length,
      personaTruncated: persona.truncated,
      registryChars: registry.length,
      claudeMdChars: claudeMd.length,
      // Estimate: only <sdkCwd>/CLAUDE.md, parent dirs the SDK also walks are not counted.
      sdkCwdClaudeMdChars:
        sdkFile && existsSync(sdkFile) ? readFileSync(sdkFile, "utf8").length : 0,
      memoryRootChars: rootChars,
      memoryWorkspaceChars: Math.max(0, memory.length - rootChars),
      totalChars: blocks.reduce((n, b) => n + b.length, 0),
    },
    persona.truncated ? "warn" : "info",
  );
  return blocks.filter(Boolean);
}

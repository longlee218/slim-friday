import type { ToolWarningDto } from "@friday/contracts";
import { logger } from "../observability/logger";

const log = logger.child({ module: "tool-check" });

/** A missing tool and how to install it. */
export type ToolWarning = ToolWarningDto;

const UVX = "uvx";
const PDFTOTEXT = "pdftotext";

/** The tools the `office-files` skill needs, with their install hints. */
const WANTED: readonly ToolWarning[] = [
  { tool: UVX, hint: "brew install uv" },
  { tool: PDFTOTEXT, hint: "brew install poppler" },
];

/**
 * The wanted tools that are not on PATH. Logs one warning per missing tool (name only). Never throws: the engine
 * works without them.
 */
export function checkTools(
  which: (name: string) => string | null = (name) => Bun.which(name),
): ToolWarning[] {
  const missing = WANTED.filter((w) => !which(w.tool));
  for (const w of missing) log.warn({ tool: w.tool }, "tool.missing");
  return missing.map((w) => ({ ...w }));
}

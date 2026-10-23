import type { ToolSpec } from "../domain/tool";

/** The tools that exist, with their annotations. */
export interface ToolCatalog {
  list(): Promise<ToolSpec[]>;
}

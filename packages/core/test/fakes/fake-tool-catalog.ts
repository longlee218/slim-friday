import type { ToolCatalog, ToolSpec } from "../../src";

/** A catalog with a fixed tool list. */
export class FakeToolCatalog implements ToolCatalog {
  constructor(private tools: ToolSpec[]) {}
  async list(): Promise<ToolSpec[]> {
    return this.tools;
  }
}

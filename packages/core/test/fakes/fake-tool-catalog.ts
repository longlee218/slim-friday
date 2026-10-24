import type { ToolCatalog, ToolSpec } from "../../src";

/** A catalog with a tool list the test may change (`tools`). */
export class FakeToolCatalog implements ToolCatalog {
  constructor(public tools: ToolSpec[]) {}
  async list(): Promise<ToolSpec[]> {
    return this.tools;
  }
}

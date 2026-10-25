import { expect, test } from "bun:test";
import { FRIDAY_MCP_SERVERS } from "@friday/core";
import * as names from "../src/mcp-server-names";

// The taint policy treats every MCP server not in core's list as external: both lists must stay equal.
test("core's list of Friday MCP servers matches the tools' server names", () => {
  expect([...FRIDAY_MCP_SERVERS].sort()).toEqual(Object.values(names).sort());
});

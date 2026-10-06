import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ghToken, githubMcpServer } from "../src/mcp/github-mcp";

/** Live read-only check against the real server; opt-in via FRIDAY_LIVE_GITHUB=1. Writes nothing. */
test.skipIf(process.env.FRIDAY_LIVE_GITHUB !== "1")(
  "read-only github mcp: identity is longlhdev",
  async () => {
    const spec = githubMcpServer({
      token: await ghToken("longlhdev"),
      readOnly: true,
      toolsets: "context,repos,issues,pull_requests", // get_me lives in "context"
    });
    const c = new Client({ name: "live-check", version: "1.0.0" });
    await c.connect(new StdioClientTransport({ ...spec, stderr: "ignore" }));
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      process.stderr.write(`TOOLS(${names.length}): ${names.join(",")}\n`);
      const me = await c.callTool({ name: "get_me", arguments: {} });
      const txt = JSON.stringify(me.content);
      expect(txt).toContain("longlhdev");
    } finally {
      await c.close();
    }
  },
  90_000,
);

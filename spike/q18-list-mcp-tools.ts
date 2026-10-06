// Q18: list the real tools (name, required params, description) of a stdio MCP server.
// Usage: bun spike/q18-list-mcp-tools.ts <command> [args...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("usage: bun spike/q18-list-mcp-tools.ts <command> [args...]");
const client = new Client({ name: "friday-q18", version: "0.0.1" });
await client.connect(
  new StdioClientTransport({
    command,
    args,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  }),
);
const { tools } = await client.listTools();
for (const t of tools) {
  const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  const props = Object.keys(schema.properties ?? {});
  const req = new Set(schema.required ?? []);
  const params = props.map((p) => (req.has(p) ? p : `${p}?`)).join(", ");
  console.log(`${t.name}(${params})\n    ${(t.description ?? "").split("\n")[0]?.slice(0, 140)}`);
}
console.log(`\n${tools.length} tools`);
await client.close();

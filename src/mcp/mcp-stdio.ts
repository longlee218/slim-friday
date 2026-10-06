import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** How to start an MCP server over stdio (the shape SDK `mcpServers` entries also use). */
export interface StdioSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Start the server and connect a client to it (server stderr is dropped so nothing leaks into our logs). */
export async function connectStdio(spec: StdioSpec): Promise<Client> {
  const client = new Client({ name: "friday-app", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ ...spec, stderr: "ignore" }));
  return client;
}

/** Text parts of an MCP tool result, one per line. Callers cap and redact it before showing it. */
export function toolText(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] })?.content;
  return (content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/**
 * Measures the MCP tool definitions each role's model receives (name + description + JSON schema), as the runtime
 * builds them (`buildServers` over a full fake ctx, filtered by `role.mcpTools`). Prints a markdown table:
 * chars and approx tokens (chars / 4) per role, plus the per-tool breakdown with `--tools`.
 * Run: `bun scripts/measure-tool-schema-size.ts [--tools]`. External (http) servers expose no definition here.
 */
import { z } from "zod";
import { buildServers } from "../src/mcp/mcp-servers";
import { getRole } from "../src/roles/role-registry";
import { FULL_CTX } from "../test/mcp-ctx-fixture";

const ROLES = ["lead", "planner", "scout", "developer", "tester", "discord-manager"];

interface Sized {
  name: string;
  chars: number;
}

/** Serialized definition of every in-process tool of a role: what the model reads (name, description, schema). */
function toolSizes(role: string): Sized[] {
  const servers = buildServers(getRole(role), FULL_CTX) as Record<string, any>;
  return Object.entries(servers)
    .filter(([, s]) => s.type !== "http")
    .flatMap(([server, s]) =>
      Object.entries<any>(s.instance._registeredTools).map(([name, t]) => ({
        name: `${server}/${name}`,
        chars: JSON.stringify({
          name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ? z.toJSONSchema(t.inputSchema) : {},
        }).length,
      })),
    );
}

const showTools = process.argv.includes("--tools");
const out: string[] = ["| role | tools | chars | ~tokens |", "|---|---|---|---|"];
const detail: string[] = [];
for (const role of ROLES) {
  const sizes = toolSizes(role);
  const chars = sizes.reduce((n, t) => n + t.chars, 0);
  out.push(`| ${role} | ${sizes.length} | ${chars} | ${Math.round(chars / 4)} |`);
  detail.push(`${role}: ${sizes.map((t) => `${t.name}=${t.chars}`).join(", ")}`);
}
process.stdout.write(`${out.join("\n")}\n`);
if (showTools) process.stdout.write(`\n${detail.join("\n")}\n`);

/**
 * Measures the MCP tool definitions each role's model receives (name + description + JSON schema), as the runtime
 * builds them (`buildServers` over a full fake ctx, filtered by `role.mcpTools`). Prints a markdown table:
 * chars and approx tokens (chars / 4) per role, plus the per-tool breakdown with `--tools`.
 * Run: `bun scripts/measure-tool-schema-size.ts [--tools]`. External (http) servers expose no definition here.
 */
import { toolDefinitions } from "../src/runtime/prompt-preview/tool-definitions";
import { getRole, ROLES as ROLE_REGISTRY } from "../src/roles/role-registry";
import { FULL_CTX } from "../test/mcp-ctx-fixture";

/** Every registered role (a removed role can never linger here). */
const ROLES = Object.keys(ROLE_REGISTRY);

interface Sized {
  name: string;
  chars: number;
}

/** Serialized definition of every in-process tool of a role: what the model reads (name, description, schema). */
const toolSizes = (role: string): Sized[] =>
  toolDefinitions(getRole(role), FULL_CTX).tools.map((t) => ({
    name: `${t.server}/${t.name}`,
    chars: t.chars,
  }));

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

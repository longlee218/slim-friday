/**
 * Offline view of the exact system prompts (layers, skills, tools) of the roles, built by the runtime's own functions.
 * No API call, no bot. Run: `bun run prompt:show <role|--all> [--home <AGENT_HOME>] [--workspace <name> --channel <name>]
 * [--out <file.md>] [--tools] [--no-skills]`. Without --home a throwaway home with the default persona files is used.
 */
import { writeFileSync } from "node:fs";
import { makeDefaultHome } from "../src/runtime/prompt-preview/default-home";
import { PREVIEW_ROLES, renderPromptShow } from "../src/runtime/prompt-preview/show";
import { FULL_CTX } from "../test/mcp-ctx-fixture";

const args = process.argv.slice(2);
/** Value of `--name <value>`, or undefined. */
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const valueFlags = new Set(["--home", "--workspace", "--channel", "--out"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !valueFlags.has(args[i - 1] ?? ""));
const roles = args.includes("--all") ? PREVIEW_ROLES : positional.slice(0, 1);
const bad = roles.find((r) => !PREVIEW_ROLES.includes(r));
if (roles.length === 0 || bad) {
  process.stderr.write(
    `${bad ? `unknown role: ${bad}\n` : ""}usage: bun run prompt:show <${PREVIEW_ROLES.join("|")}|--all> [--home <dir>] [--workspace <name> --channel <name>] [--out <file.md>] [--tools] [--no-skills]\n`,
  );
  process.exit(1);
}

const md = renderPromptShow({
  roles,
  agentHome: opt("--home") ?? makeDefaultHome(),
  workspace: opt("--workspace"),
  channel: opt("--channel"),
  tools: args.includes("--tools"),
  skills: !args.includes("--no-skills"),
  ctx: FULL_CTX,
});
const out = opt("--out");
if (out) {
  writeFileSync(out, md, { mode: 0o600 }); // may hold the owner's persona and memory files
  process.stdout.write(`${md.split("\n## ")[0]?.slice(0, 4000)}\nwritten: ${out}\n`);
} else process.stdout.write(md);

import { basename } from "node:path";

/** Run a git command in cwd; returns trimmed stdout or null when exit code != 0. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : null;
  } catch {
    return null; // git missing or cwd invalid
  }
}

/** Short repo context: name, branch, and a capped `git status --short` summary. */
export async function buildRepoContext(cwd: string): Promise<string> {
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = await git(cwd, ["status", "--short"]);
  const lines = (status ?? "").split("\n").filter(Boolean);
  const shown = lines.slice(0, 20).join("\n");
  const more = lines.length > 20 ? `\n...(+${lines.length - 20} more)` : "";
  return [
    `Repository: ${basename(cwd)}`,
    `Branch: ${branch ?? "unknown (not a git repo)"}`,
    `Uncommitted changes: ${lines.length === 0 ? "none" : `${lines.length} file(s)\n${shown}${more}`}`,
  ].join("\n");
}

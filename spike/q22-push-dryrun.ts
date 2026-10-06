// Q22: does a push from the git MCP server authenticate against the real remote? (dry run: pushes nothing)
import { createGitMcp } from "../src/git/git-mcp";
const git = createGitMcp();
const clone = "/Users/example/orca/projects/friday-slim-agent/.friday/workspaces/superminds-cms/repo";
console.log(JSON.stringify(await git.call("git_push", { path: clone, remote: "origin", branch: "develop", dryRun: true })).slice(0, 300));
console.log(JSON.stringify(await git.call("git_fetch", { path: clone, remote: "origin" })).slice(0, 200));
await git.close();

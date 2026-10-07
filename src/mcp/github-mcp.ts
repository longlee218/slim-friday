import { pickEnv } from "../config/agent-config";
import { errText } from "../observability/redact";
import { connectStdio, type StdioSpec, toolText } from "./mcp-stdio";
import { GITHUB_TOOL } from "./mcp-tool-names";

/** Official GitHub MCP server image (stdio). */
export const GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server";

/** Default toolsets the server exposes. */
const DEFAULT_TOOLSETS = "repos,issues,pull_requests";

/** Overall time budget for token fetch, server start and the PR calls. */
const TIMEOUT_MS = 60_000;

/** Result of a finished command. */
export interface CmdResult {
  code: number;
  stdout: string;
}

/** Command runner; injectable in tests. */
export type RunCmd = (cmd: string[]) => Promise<CmdResult>;

/** Default runner: spawn, collect stdout (stderr is dropped so no token/text leaks into errors). */
const spawnCmd: RunCmd = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
};

/**
 * Token of a logged-in `gh` account (`gh auth token [--user X]`); omit `account` for the active one.
 * Throws a generic Error: neither the token nor gh's stderr ever reaches the message.
 */
export async function ghToken(account?: string, run: RunCmd = spawnCmd): Promise<string> {
  const r = await run(["gh", "auth", "token", ...(account ? ["--user", account] : [])]);
  const token = r.stdout.trim();
  if (r.code !== 0 || !token) {
    throw new Error(`no gh token for ${account ? `account "${account}"` : "active account"}`);
  }
  return token;
}

/**
 * Docker command that runs the GitHub MCP server for ONE account.
 * The token travels only in `env` (`-e VAR` without value makes docker copy it from the child
 * env), so it never shows in argv or process listings. PATH/HOME are passed because docker needs them.
 */
export function githubMcpServer(o: {
  token: string;
  readOnly: boolean;
  toolsets?: string;
}): StdioSpec {
  const args = [
    ...["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "-e", "GITHUB_TOOLSETS"],
    ...(o.readOnly ? ["-e", "GITHUB_READ_ONLY=1"] : []),
    GITHUB_MCP_IMAGE,
    "stdio",
  ];
  const env = {
    ...pickEnv(["PATH", "HOME"]),
    GITHUB_PERSONAL_ACCESS_TOKEN: o.token,
    GITHUB_TOOLSETS: o.toolsets ?? DEFAULT_TOOLSETS,
  };
  return { command: "docker", args, env };
}

/** `owner/repo` from a git remote url (ssh `git@host:O/R` or http(s) form); null if unparsable. */
export function parseRemote(url: string): { owner: string; repo: string } | null {
  const m =
    /^(?:git@[^:]+:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return m ? { owner: m[1] as string, repo: m[2] as string } : null;
}

/** First PR html url found in tool output (JSON `html_url`/`url`, else any github pull url). */
function findUrl(text: string): string | undefined {
  try {
    const j = JSON.parse(text) as unknown;
    const first = Array.isArray(j) ? j[0] : j;
    const o = first as { html_url?: string; url?: string } | undefined;
    const u = o?.html_url ?? o?.url;
    if (typeof u === "string" && /\/pull\/\d+/.test(u)) return u;
  } catch {
    // not JSON: fall back to regex
  }
  return /https:\/\/github\.com\/[^\s"]+\/pull\/\d+/.exec(text)?.[0];
}

/** Outcome of opening a PR. */
export type CreatePrResult = { ok: true; url: string } | { ok: false; error: string };

/** Minimal MCP client surface the PR flow needs. */
export interface PrClient {
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
}

/** Create the PR, or reuse the open one for this head branch (follow-up push). */
export async function openPr(
  c: PrClient,
  o: { owner: string; repo: string; head: string; base: string; title: string; body: string },
): Promise<CreatePrResult> {
  const { owner, repo, head, base, title, body } = o;
  const isErr = (res: unknown) => (res as { isError?: boolean })?.isError === true;
  const create = await c.callTool({
    name: GITHUB_TOOL.CREATE_PULL_REQUEST,
    arguments: { owner, repo, head, base, title, body },
  });
  const url = isErr(create) ? undefined : findUrl(toolText(create));
  if (url) return { ok: true, url };
  const list = await c.callTool({
    name: GITHUB_TOOL.LIST_PULL_REQUESTS,
    arguments: { owner, repo, head: `${owner}:${head}`, state: "open", perPage: 1 },
  });
  const existing = isErr(list) ? undefined : findUrl(toolText(list));
  if (existing) return { ok: true, url: existing };
  const why = errText(toolText(create)) || "no PR url";
  return { ok: false, error: `${GITHUB_TOOL.CREATE_PULL_REQUEST} failed: ${why}` };
}

/**
 * Open a PR through a write-enabled GitHub MCP server started with the token of `account`.
 * Never throws; errors are redacted and carry no token.
 */
export async function createPullRequest(
  o: Parameters<typeof openPr>[1] & { account?: string },
): Promise<CreatePrResult> {
  let mcp: Awaited<ReturnType<typeof connectStdio>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("github mcp timeout")), TIMEOUT_MS);
    });
    const work = (async () => {
      const token = await ghToken(o.account);
      mcp = await connectStdio(
        githubMcpServer({ token, readOnly: false, toolsets: "pull_requests" }),
      );
      return openPr(mcp, o);
    })();
    return await Promise.race([work, timeout]);
  } catch (err) {
    return { ok: false, error: errText(err) };
  } finally {
    if (timer) clearTimeout(timer);
    await mcp?.close().catch(() => {});
  }
}

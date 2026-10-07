import { expect, test } from "bun:test";
import {
  GITHUB_MCP_IMAGE,
  ghToken,
  githubMcpServer,
  openPr,
  type PrClient,
  parseRemote,
} from "../src/mcp/github-mcp";
import { GITHUB_TOOL } from "../src/mcp/mcp-tool-names";

// Fake token shaped like a real one (the redactor only masks real-looking tokens).
const SECRET = `ghp_${"S3cr3t".repeat(6)}`;
const pr = { owner: "o", repo: "r", head: "agent/x", base: "main", title: "t", body: "b" };
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

test("config: token only in env, never in args", () => {
  for (const readOnly of [true, false]) {
    const s = githubMcpServer({ token: SECRET, readOnly });
    expect(s.command).toBe("docker");
    expect(s.args.join(" ")).not.toContain(SECRET);
    expect(s.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(SECRET);
    expect(s.args).toContain(GITHUB_MCP_IMAGE);
    expect(s.args.includes("GITHUB_READ_ONLY=1")).toBe(readOnly);
    expect(s.env.GITHUB_TOOLSETS).toBe("repos,issues,pull_requests");
    expect(
      Object.keys(s.env).every((k) =>
        ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOOLSETS", "PATH", "HOME"].includes(k),
      ),
    ).toBe(true);
  }
  expect(
    githubMcpServer({ token: "t", readOnly: true, toolsets: "repos" }).env.GITHUB_TOOLSETS,
  ).toBe("repos");
});

test("parseRemote handles ssh and https forms", () => {
  const want = { owner: "Acme", repo: "widgets" };
  expect(parseRemote("git@github.com:Acme/widgets.git")).toEqual(want);
  expect(parseRemote("https://github.com/Acme/widgets.git")).toEqual(want);
  expect(parseRemote("https://github.com/Acme/widgets")).toEqual(want);
  expect(parseRemote("https://user:x@github.com/Acme/widgets.git\n")).toEqual(want);
  expect(parseRemote("/local/path")).toBeNull();
});

test("ghToken passes --user, trims, and hides failures", async () => {
  const seen: string[][] = [];
  const t = await ghToken("bob", async (c) => {
    seen.push(c);
    return { code: 0, stdout: " tok\n", stderr: "" };
  });
  expect(t).toBe("tok");
  expect(seen[0]).toEqual(["gh", "auth", "token", "--user", "bob"]);
  await ghToken(undefined, async (c) => {
    seen.push(c);
    return { code: 0, stdout: "a", stderr: "" };
  });
  expect(seen[1]).toEqual(["gh", "auth", "token"]);
  const err = await ghToken("x", async () => ({ code: 1, stdout: SECRET, stderr: SECRET })).catch(
    (e) => e,
  );
  expect(String(err)).not.toContain(SECRET);
});

test("openPr: success parses url", async () => {
  const client: PrClient = {
    callTool: async () => text(JSON.stringify({ url: "https://github.com/o/r/pull/5" })),
  };
  expect(await openPr(client, pr)).toEqual({
    ok: true,
    url: "https://github.com/o/r/pull/5",
  });
});

test("openPr: already exists -> lists and returns existing url", async () => {
  const names: string[] = [];
  const client: PrClient = {
    callTool: async (r) => {
      names.push(r.name);
      return r.name === GITHUB_TOOL.CREATE_PULL_REQUEST
        ? text("a pull request already exists", true)
        : text(JSON.stringify([{ html_url: "https://github.com/o/r/pull/9" }]));
    },
  };
  expect(await openPr(client, pr)).toEqual({
    ok: true,
    url: "https://github.com/o/r/pull/9",
  });
  expect(names).toEqual([GITHUB_TOOL.CREATE_PULL_REQUEST, GITHUB_TOOL.LIST_PULL_REQUESTS]);
});

test("openPr: error text never leaks the token", async () => {
  const r = await openPr({ callTool: async () => text(`bad ${SECRET}`, true) }, pr);
  expect(r.ok).toBe(false);
  expect(JSON.stringify(r)).not.toContain(SECRET);
});

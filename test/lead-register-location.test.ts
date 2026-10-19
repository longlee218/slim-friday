import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspacePaths } from "../src/config/workspace-paths";
import { createWorkspaceDir } from "../src/discord-setup/workspace-template";
import { type LeadPlace, leadCall } from "../src/orchestrator/lead/lead-call";
import {
  confirmText,
  handleRegisterLocation,
} from "../src/orchestrator/lead/lead-location-handler";
import { pathInText } from "../src/orchestrator/lead/owner-path-match";
import { inspectLocation } from "../src/workspaces/location-candidate";
import { assertTempHome } from "./helpers";
import { FakePort, leadCtx } from "./lead-fake-port";

const CH = "100000000000000001";
const YES = { answer: "Yes", timedOut: false };

/** Temp owner home + AGENT_HOME with space `w` (channel CH) and a project dir (a git repo with a README) to register. */
function setup(channelExtra = "") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "friday-rl-")));
  const userHome = join(base, "user");
  const home = join(userHome, ".friday");
  mkdirSync(home, { recursive: true });
  assertTempHome(home);
  createWorkspaceDir(home, "w");
  const { config } = workspacePaths(home).workspace("w");
  writeFileSync(config, `channels:\n  - id: "${CH}"\n    name: c\n    mode: task\n${channelExtra}`);
  const proj = join(base, "proj", "shop");
  mkdirSync(join(proj, ".git"), { recursive: true });
  writeFileSync(join(proj, "README.md"), "# Shop app\n");
  return { home, userHome, config, proj, refreshed: 0 };
}
type Setup = ReturnType<typeof setup>;

/** Context of an owner run whose message holds the project path. */
function ctxFor(s: Setup, port: FakePort, over: Partial<LeadPlace> = {}) {
  const ctx = leadCtx(port);
  ctx.place = {
    home: s.home,
    workspace: "w",
    channel: "c",
    channelId: CH,
    trigger: "owner",
    ownerText: `work in ${s.proj}`,
    refresh: () => void s.refreshed++,
    ...over,
  };
  return ctx;
}
const yamlOf = (s: Setup) => readFileSync(s.config, "utf8");
const call = (s: Setup, ctx: ReturnType<typeof leadCtx>, path = s.proj) =>
  handleRegisterLocation(ctx, { path }, s.userHome);

test("announce run is refused NOT_OWNER_TURN, nothing asked or written", async () => {
  const s = setup();
  const port = new FakePort();
  const r = await call(s, ctxFor(s, port, { trigger: "announce", ownerText: undefined }));
  expect(r).toMatchObject({ ok: false, code: "NOT_OWNER_TURN" });
  expect(port.asked).toEqual([]);
  expect(yamlOf(s)).not.toContain("shop");
});

test("path absent from the owner message is refused PATH_NOT_IN_MESSAGE", async () => {
  const s = setup();
  const port = new FakePort();
  const r = await call(s, ctxFor(s, port, { ownerText: "work in the shop repo" }));
  expect(r).toMatchObject({ ok: false, code: "PATH_NOT_IN_MESSAGE" });
  expect(port.asked).toEqual([]);
});

test("a blank path never matches (whitespace is a substring of any text)", async () => {
  const s = setup();
  const r = await call(s, ctxFor(s, new FakePort()), "   ");
  expect(r).toMatchObject({ ok: false, code: "PATH_NOT_IN_MESSAGE" });
});

test("second call in one run is LIMIT; the first (denied) call counted", async () => {
  const s = setup();
  const port = new FakePort();
  port.answer = { answer: "No", timedOut: false };
  const ctx = ctxFor(s, port);
  expect(await call(s, ctx)).toMatchObject({ code: "OWNER_DENIED" });
  expect(await call(s, ctx)).toMatchObject({ code: "LIMIT" });
  expect(port.asked).toHaveLength(1);
});

test("owner No or timeout: nothing written, no audit row, no refresh", async () => {
  for (const answer of [{ answer: "No", timedOut: false }, { timedOut: true }]) {
    const s = setup();
    const port = new FakePort();
    port.answer = answer;
    expect(await call(s, ctxFor(s, port))).toMatchObject({ ok: false, code: "OWNER_DENIED" });
    expect(yamlOf(s)).not.toContain("locations");
    expect(port.audits).toEqual([]);
    expect(s.refreshed).toBe(0);
  }
});

test("BAD_PATH passes the reason (credential dir) and asks nothing", async () => {
  const s = setup();
  const ssh = join(s.userHome, ".ssh");
  mkdirSync(ssh, { recursive: true });
  const port = new FakePort();
  const r = await call(s, ctxFor(s, port, { ownerText: `use ${ssh}` }), ssh);
  expect(r).toEqual({ ok: false, code: "BAD_PATH", message: "credential directory" });
  expect(port.asked).toEqual([]);
});

test("Yes: yaml entry + audit row (owner, real path) + refresh; replay is the stored reply, one row", async () => {
  const s = setup();
  const port = new FakePort();
  port.answer = YES;
  const ctx = ctxFor(s, port);
  const r = await call(s, ctx);
  expect(r).toMatchObject({ ok: true, location: "shop", path: s.proj, git: true, linked: true });
  expect(yamlOf(s)).toContain("name: shop");
  expect(s.refreshed).toBe(1);
  expect(port.audits).toHaveLength(1);
  expect(port.audits[0]).toMatchObject({ grantedBy: "owner", scope: `${s.proj} -> w/c` });
  // Same input id + args: the stored reply, no second question, no second row.
  const again = await call(s, { ...ctx, run: { dispatched: 0, registered: 0 } });
  expect(again).toEqual(r);
  expect(port.asked).toHaveLength(1);
  expect(port.audits).toHaveLength(1);
});

test("a ~/ path given expanded by the model matches the owner's ~/ text", async () => {
  const s = setup();
  const dir = join(s.userHome, "code", "shop");
  mkdirSync(dir, { recursive: true });
  const port = new FakePort();
  port.answer = YES;
  const r = await call(s, ctxFor(s, port, { ownerText: "work in ~/code/shop" }), dir);
  expect(r).toMatchObject({ ok: true, location: "shop" });
});

test("channel with a locations subset gets the new name appended", async () => {
  const s = setup('    locations: ["app"]\n');
  const app = join(s.proj, "..", "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(
    s.config,
    `${yamlOf(s)}locations:\n  - name: app\n    path: ${app}\n    description: app\n`,
  );
  const port = new FakePort();
  port.answer = YES;
  expect(await call(s, ctxFor(s, port))).toMatchObject({ ok: true });
  expect((Bun.YAML.parse(yamlOf(s)) as any).channels[0].locations).toEqual(["app", "shop"]);
});

test("confirm text: path, git, sensitive count + 3 names, incomplete flag, other spaces", () => {
  const s = setup();
  for (const n of [".env", "a.pem", "b.pem", "c.pem"]) writeFileSync(join(s.proj, n), "x");
  const c = inspectLocation(s.home, "w", s.proj, s.userHome);
  if (!c.ok) throw new Error(c.reason);
  const t = confirmText(
    { ...c, sensitiveTruncated: true, otherSpaces: ["x/y"] },
    { workspace: "w", channel: "c" },
  );
  expect(t).toContain(`Path: \`${s.proj}\``);
  expect(t).toContain("Git repo: yes");
  expect(t).toContain("Sensitive files: 4 (");
  expect(t).toContain(", ...)");
  expect(t).toContain("Sensitive search incomplete");
  expect(t).toContain("also used by x/y");
  expect(t).toContain("full read/write");
  expect(confirmText({ ...c, sensitiveTruncated: false }, { workspace: "w" })).not.toContain(
    "incomplete",
  );
});

test("leadCall records a custom audit scope and grantor", async () => {
  const port = new FakePort();
  await leadCall(leadCtx(port), "t", {}, () => ({
    reply: { ok: true },
    audit: { scope: "s", grantedBy: "owner" },
  }));
  expect(port.audits[0]).toMatchObject({ tool: "Orchestrate.t", scope: "s", grantedBy: "owner" });
});

test("token match: a parent or prefix of a longer typed path is refused; exact, punctuation and slash forms pass", () => {
  const h = "/Users/me";
  expect(pathInText("/a/shop", "work in /a/shop/sub", h)).toBe(false);
  expect(pathInText("/a", "work in /a/shop", h)).toBe(false);
  expect(pathInText("/a/shop", "work in /a/shop-old", h)).toBe(false);
  expect(pathInText("/a/shop", "work in /a/shop.bak", h)).toBe(false);
  expect(pathInText("/a/shop", "work in /x/a/shop", h)).toBe(false);
  expect(pathInText("/a/shop", "work in /A/SHOP", h)).toBe(false); // case differs: fail closed
  expect(pathInText("/a/shop", "work in /a/shop\u0435", h)).toBe(false); // lookalike letter after
  expect(pathInText("/a/shop", "work in /a/shop.", h)).toBe(true);
  expect(pathInText("/a/shop", "use '/a/shop', ok", h)).toBe(true);
  expect(pathInText("/a/shop", "use /a/shop/", h)).toBe(true);
  expect(pathInText("/a/shop", "use (/a/shop)", h)).toBe(true);
  expect(pathInText("/Users/me/code/shop", "use ~/code/shop please", h)).toBe(true);
  expect(pathInText("/Users/me/code/shop", "use ~/code/shop/x", h)).toBe(false);
});

test("token match: bare ~, / and $HOME only as a whole token", () => {
  const h = "/Users/me";
  expect(pathInText("~", "wait ~5 min", h)).toBe(false);
  expect(pathInText("~", "a ~/x dir", h)).toBe(false);
  expect(pathInText("/", "see a/b and /a/shop", h)).toBe(false);
  expect(pathInText(h, "work in /Users/me/code", h)).toBe(false);
  expect(pathInText(h, "work in /Users/me", h)).toBe(true);
  expect(pathInText("~", "work in ~", h)).toBe(true);
  expect(pathInText("   ", "anything", h)).toBe(false);
});

test("confirm text: a newline in the real path is escaped, no extra line", () => {
  const s = setup();
  const odd = join(s.proj, "..", "we\nird");
  mkdirSync(odd, { recursive: true });
  const c = inspectLocation(s.home, "w", odd, s.userHome);
  if (!c.ok) throw new Error(c.reason);
  const t = confirmText(c, { workspace: "w", channel: "c" });
  expect(t).toContain("\\x0a");
  expect(t.split("\n").filter((l) => l.startsWith("Path:"))).toHaveLength(1);
  expect(t.split("\n")).toHaveLength(4); // title, path, git, final line
});

test("confirm text stays under 1500 with huge inputs and keeps the sensitive lines", () => {
  const s = setup();
  const c = inspectLocation(s.home, "w", s.proj, s.userHome);
  if (!c.ok) throw new Error(c.reason);
  const t = confirmText(
    {
      ...c,
      realPath: `/${"p".repeat(1000)}`,
      name: "n".repeat(64),
      sensitive: Array.from({ length: 500 }, () => "x".repeat(200)),
      sensitiveTruncated: true,
      otherSpaces: Array.from({ length: 50 }, () => "a".repeat(100)),
    },
    { workspace: "w".repeat(64), channel: "c".repeat(100) },
  );
  expect(t.length).toBeLessThan(1500);
  expect(t).toContain("Sensitive files: 500");
  expect(t).toContain("Sensitive search incomplete");
  expect(t).toContain("full read/write");
});

test("a failed write is WRITE_FAILED (channel not in the space), nothing audited", async () => {
  const s = setup();
  const port = new FakePort();
  port.answer = YES;
  const r = await call(s, ctxFor(s, port, { channelId: "999" }));
  expect(r).toMatchObject({ ok: false, code: "WRITE_FAILED" });
  expect(port.audits).toEqual([]);
  expect(s.refreshed).toBe(0);
});

test("two parallel calls in one run: the first asks, the second is LIMIT", async () => {
  const s = setup();
  const other = join(s.proj, "..", "other");
  mkdirSync(other, { recursive: true });
  const port = new FakePort();
  port.answer = YES;
  const ctx = ctxFor(s, port, { ownerText: `use ${s.proj} and ${other}` });
  const [a, b] = await Promise.all([call(s, ctx), call(s, ctx, other)]);
  expect([a, b].filter((r) => r.ok)).toHaveLength(1);
  expect(b).toMatchObject({ ok: false, code: "LIMIT" });
  expect(port.asked).toHaveLength(1);
});

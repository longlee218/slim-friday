import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeArtifact } from "../src/artifacts/artifact-writer";
import { VIEWER_LINK_TTL_DEFAULT_MS, type ViewerConfig } from "../src/config/viewer-config";
import { insertArtifact } from "../src/storage/artifact-store";
import { signedArtifactUrl } from "../src/viewer/signed-link";
import { createViewerHandler, startViewer } from "../src/viewer/viewer-server";
import { makeEnv, outsideDir } from "./helpers";

const cfg: ViewerConfig = {
  port: 0,
  baseUrl: "http://127.0.0.1",
  secret: "k".repeat(32),
  linkTtlMs: VIEWER_LINK_TTL_DEFAULT_MS,
};

/** A db + home + one location dir (docs/plan.md, a secret file, a symlink out), and the handler over them. */
function setup() {
  const env = makeEnv();
  const root = outsideDir();
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "plan.md"), "# Location plan");
  writeFileSync(join(root, ".env"), "TOKEN=1");
  writeFileSync(join(outsideDir(), "o.md"), "outside");
  const outside = join(outsideDir(), "o.md");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(root, "docs", "link.md"));
  const handler = createViewerHandler({
    db: env.db,
    config: cfg,
    roots: {
      home: env.home,
      locationPath: (ws, n) => (ws === "main" && n === "loc" ? root : undefined),
    },
  });
  const save = (kind: "md" | "html" | "txt" | "diff" | "csv", body: string, title = "Doc") =>
    writeArtifact(env.db, env.home, { workspace: "main", channel: "c", title, kind, body }).id;
  /** A repo artifact row pointing at `path` of the location (inserted directly: the read side is under test). */
  const repo = (path: string, location = "loc") => {
    const id = crypto.randomUUID();
    insertArtifact(env.db, {
      id,
      workspace: "main",
      channel: "c",
      goalId: null,
      taskId: null,
      threadId: null,
      title: "Location doc",
      name: "repo.md",
      kind: "md",
      origin: "repo",
      path,
      location,
      producerRole: null,
      version: 1,
      size: 1,
      sourceMtime: null,
      createdAt: Date.now(),
    });
    return id;
  };
  const get = (id: string) => handler(new Request(signedArtifactUrl(cfg, id)));
  return { ...env, handler, save, repo, get };
}

const HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
};

test("md renders with security headers; raw html and javascript: links are escaped", async () => {
  const { save, get } = setup();
  const id = save(
    "md",
    "# Plan\n\n## Two\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1)) **b**",
  );
  const res = get(id);
  expect(res.status).toBe(200);
  for (const [k, v] of Object.entries(HEADERS)) expect(res.headers.get(k)).toBe(v);
  expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  const html = await res.text();
  expect(html.match(/<script/g)?.length).toBe(1); // only the layout's own, hash-pinned script
  expect(html).not.toContain("<script>alert");
  expect(res.headers.get("content-security-policy")).toContain("script-src 'sha256-");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).not.toContain('href="javascript:'); // an invalid link stays literal text, never an anchor
  expect(html).toContain("<strong>b</strong>");
  expect(html).toContain('<nav aria-label="Contents">'); // TOC from the headings
});

test("html is wrapped in a sandboxed iframe (scripts yes, same origin no) with the inner policy", async () => {
  const { save, get } = setup();
  const id = save("html", "<h1>hi</h1><script>fetch('https://evil')</script>");
  const res = get(id);
  const html = await res.text();
  expect(html).toContain('sandbox="allow-scripts"');
  expect(html).not.toContain("allow-same-origin");
  expect(html).toContain("srcdoc=");
  expect(html).toContain("&lt;script&gt;fetch"); // the artifact sits in the escaped attribute, not in the wrapper
  expect(html).toContain("Content-Security-Policy");
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toContain("frame-src 'self'");
  expect(csp).not.toContain("connect-src");
  expect(csp).toContain("default-src 'none'");
});

test("diff, csv and txt are escaped <pre>", async () => {
  const { save, get } = setup();
  for (const kind of ["diff", "csv", "txt"] as const) {
    const html = await get(save(kind, "a<b>&c", `T ${kind}`)).text();
    expect(html).toContain("<pre>a&lt;b&gt;&amp;c</pre>");
  }
});

test("404 with no detail: bad signature, expired, unknown id, other paths and methods, deleted artifact", async () => {
  const { save, handler, db, get } = setup();
  const id = save("md", "# x");
  const ok = signedArtifactUrl(cfg, id);
  const u = new URL(ok);
  const tampered = `${u.origin}${u.pathname}?e=${u.searchParams.get("e")}&s=${"0".repeat(64)}`;
  const expired = signedArtifactUrl(cfg, id, Date.now() - 2 * VIEWER_LINK_TTL_DEFAULT_MS);
  const unknown = signedArtifactUrl(cfg, "no-such-id");
  const cases: Request[] = [
    new Request(tampered),
    new Request(expired),
    new Request(unknown),
    new Request(`${u.origin}/a/${id}`),
    new Request(`${u.origin}/`),
    new Request(`${u.origin}/a/${id}/extra${u.search}`),
    new Request(`${u.origin}/artifacts/${id}${u.search}`),
    new Request(ok, { method: "POST", body: "x" }),
    new Request(ok, { method: "DELETE" }),
  ];
  for (const r of cases) {
    const res = handler(r);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
    for (const [k, v] of Object.entries(HEADERS)) expect(res.headers.get(k)).toBe(v);
  }
  expect(get(id).status).toBe(200);
  db.query("DELETE FROM artifacts WHERE id = ?").run(id); // revoke = delete the row
  expect(get(id).status).toBe(404);
});

test("repo artifact: a file of the location is served; escape, symlink out, sensitive, unknown location refused", async () => {
  const { repo, get } = setup();
  const ok = get(repo("docs/plan.md"));
  expect(ok.status).toBe(200);
  expect(await ok.text()).toContain("Location plan");
  expect(get(repo("../x.md")).status).toBe(404);
  expect(get(repo("/etc/hosts")).status).toBe(404);
  expect(get(repo("docs/link.md")).status).toBe(404); // symlink out of the location
  expect(get(repo(".env")).status).toBe(404);
  expect(get(repo("docs/none.md")).status).toBe(404);
  expect(get(repo("docs/plan.md", "other")).status).toBe(404);
});

test("a store row that points outside AGENT_HOME is refused", () => {
  const { db, get } = setup();
  const file = join(outsideDir(), "x.md");
  writeFileSync(file, "# out");
  const id = crypto.randomUUID();
  insertArtifact(db, {
    id,
    workspace: "main",
    channel: "c",
    goalId: null,
    taskId: null,
    threadId: null,
    title: "Bad",
    name: "x.md",
    kind: "md",
    origin: "store",
    path: file,
    location: null,
    producerRole: null,
    version: 1,
    size: 1,
    sourceMtime: null,
    createdAt: Date.now(),
  });
  expect(get(id).status).toBe(404);
});

test("a real socket on 127.0.0.1 (port 0) answers a signed link and 404s the rest", async () => {
  const env = setup();
  const id = env.save("txt", "hello");
  const v = startViewer({
    db: env.db,
    config: cfg,
    roots: { home: env.home, locationPath: () => undefined },
  });
  try {
    const base = `http://127.0.0.1:${v.port}`;
    const u = new URL(signedArtifactUrl(cfg, id));
    expect((await fetch(`${base}${u.pathname}${u.search}`)).status).toBe(200);
    expect((await fetch(`${base}${u.pathname}`)).status).toBe(404);
  } finally {
    v.stop();
  }
});

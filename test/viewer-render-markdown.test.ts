import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DOC_SCRIPT } from "../src/viewer/page-doc-script";
import { renderArtifact } from "../src/viewer/render-artifact";

/** Full md page (real renderer) for a source. */
const page = (md: string) => renderArtifact("md", "T", md);

test("GFM table renders in a scroll wrapper", () => {
  const { html } = page("| a | b |\n|---|:-:|\n| 1 | 2 |");
  expect(html).toContain('<div class="table-wrap"><table>');
  expect(html).toContain("<th");
  expect(html).toContain("<td");
});

test("fenced code is highlighted server side, unknown language stays plain and escaped", () => {
  const { html } = page("```ts\nconst x: number = 1; // hi\n```\n\n```nope\n<b>&</b>\n```");
  expect(html).toContain('class="hljs language-ts"');
  expect(html).toContain('<span class="hljs-keyword">const</span>');
  expect(html).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
  expect(html).not.toContain("<b>&");
});

test("task list items get a disabled checkbox", () => {
  const { html } = page("- [x] done\n- [ ] todo\n- plain");
  expect(html).toContain('<input type="checkbox" disabled checked> done');
  expect(html).toContain('<input type="checkbox" disabled> todo');
  expect(html).toContain('<li class="task">');
});

test("raw html is escaped, never a tag", () => {
  const { html, csp } = page("<script>alert(1)</script>\n\ntext <img src=x onerror=alert(1)> end");
  expect(html.match(/<script/g)?.length).toBe(1); // only the layout's own script
  expect(html).not.toContain("<script>alert");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html.match(/<script/g)?.length).toBe(1); // only the layout's own script, never the artifact's
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/); // the script is allowed by hash only
});

test("unsafe links lose the anchor, safe ones keep rel; bare urls link, file names do not", () => {
  const { html } = page(
    "[x](javascript:alert(1)) [d](data:text/html,hi) [ok](https://a.dev/x) [m](mailto:a@b.co) [a](#sec) https://b.dev readme.md",
  );
  expect(html).not.toMatch(/href="(javascript|data):/); // invalid ones stay literal text
  expect(html).toContain('<a href="https://a.dev/x" rel="noopener noreferrer nofollow">ok</a>');
  expect(html).toContain('href="mailto:a@b.co"');
  expect(html).toContain('href="#sec"');
  expect(html).toContain('href="https://b.dev"');
  expect(html).not.toContain('href="http://readme.md"');
});

test("remote image is alt text, inline data image is kept", () => {
  const { html } = page(
    "![a](https://evil/x.png) ![b](data:image/png;base64,AAAA) ![c](data:image/svg+xml;base64,AAAA)",
  );
  expect(html).not.toContain("evil");
  expect(html).not.toContain('src="data:image/svg');
  expect(html.match(/<img /g)?.length).toBe(1);
  expect(html).toContain('src="data:image/png;base64,AAAA"');
});

test("heading ids, deduplicated and ASCII, feed the TOC", () => {
  const { html } = page("# Lộ trình\n\n## Đường đi\n\n## Đường đi\n\n## **Bold** `code`");
  expect(html).toContain('<h1 id="lo-trinh">');
  expect(html).toContain('<h2 id="duong-di">');
  expect(html).toContain('<h2 id="duong-di-1">');
  expect(html).toContain('<h2 id="bold-code">');
  expect(html).toContain('<nav aria-label="Contents">');
  expect(html).toContain('href="#duong-di-1"');
});

test("Vietnamese text and diacritics stay intact", () => {
  const text = "Kế hoạch học DevOps: Đảm bảo chất lượng, triển khai liên tục";
  const { html } = page(`# Tiêu đề\n\n${text}\n\n\`\`\`bash\necho "xin chào"\n\`\`\``);
  expect(html).toContain(text);
  expect(html).toContain("Tiêu đề");
  expect(html).toContain("xin chào");
});

test("doc layout: sidebar links to heading ids, anchors, top bar with title and kind", () => {
  const { html } = page("# A\n\n## B\n\n### C\n\n#### D");
  expect(html).toContain('<aside id="side"><nav aria-label="Contents">');
  expect(html).toContain('<li class="l2"><a href="#b">B</a></li>');
  expect(html).toContain('<li class="l3"><a href="#c">C</a></li>');
  expect(html).not.toContain('<li class="l4">');
  expect(html).toContain('<a class="anchor" href="#b" aria-label="Link to this section">#</a>');
  expect(html).toContain('<span class="name">T</span><span class="badge">md</span>');
});

test("a one-heading document has no sidebar", () => {
  const { html } = page("# Only\n\ntext");
  expect(html).not.toContain('id="side"');
  expect(html).toContain('class="layout solo"');
});

test("the one script is static, hash-pinned by the CSP, and holds no artifact text", () => {
  const secret = "ZZ-ARTIFACT-MARKER-ZZ";
  const { html, csp } = page(`# ${secret}\n\n## two\n\n\`\`\`js\n${secret}\n\`\`\``);
  const hash = createHash("sha256").update(DOC_SCRIPT).digest("base64");
  expect(csp).toContain(`script-src 'sha256-${hash}'`);
  expect(html).toContain(`<script>${DOC_SCRIPT}</script>`);
  expect(DOC_SCRIPT).not.toContain(secret);
  expect(html.split("<script>")[1]).not.toContain(secret.slice(0, 8)); // nothing after the script tag carries it
  // Two different artifacts get the identical script and hash.
  const other = renderArtifact("md", "X", "# one\n\n## two");
  expect(other.csp).toBe(csp);
});

test("other kinds keep a no-script policy", () => {
  for (const kind of ["txt", "csv", "diff"] as const) {
    const { html, csp } = renderArtifact(kind, "T", "<script>x</script>");
    expect(csp).not.toContain("script-src");
    expect(html).not.toContain("<script");
  }
});

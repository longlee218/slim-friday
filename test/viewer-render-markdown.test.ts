import { expect, test } from "bun:test";
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
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(csp).not.toContain("script-src");
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

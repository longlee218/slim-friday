import { readFileSync } from "node:fs";

const CSP_ATTR = /http-equiv=["']Content-Security-Policy["']/i;

// Returns the problems found in a built index.html (empty = ok). The CSP meta must be the
// first element of <head> so it applies before any script is parsed.
export function checkDist(html: string): string[] {
  const problems: string[] = [];
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  const firstTag = /<[a-z][^>]*>/i.exec(head)?.[0] ?? "";
  if (!CSP_ATTR.test(head)) problems.push("meta CSP missing");
  else if (!CSP_ATTR.test(firstTag)) problems.push("meta CSP not first in head");
  // A <script> tag without src is an inline script.
  if ([...html.matchAll(/<script\b[^>]*>/gi)].some((m) => !/\ssrc=/i.test(m[0]))) {
    problems.push("inline script");
  }
  if (/<[a-z][^>]*\son[a-z]+=/i.test(html)) problems.push("inline event handler");
  return problems;
}

if (import.meta.main) {
  const problems = checkDist(readFileSync(new URL("../dist/index.html", import.meta.url), "utf8"));
  if (problems.length > 0) {
    process.stderr.write(`index.html: ${problems.join(", ")}\n`);
    process.exit(1);
  }
}

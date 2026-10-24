import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useCopy } from "./use-copy";

/**
 * Fenced code with a header (title or language) and a Copy button.
 * Shiki is loaded lazily after mount; until then, and for an unknown language, a plain `<pre>`.
 * Shiki's HTML (it escapes the code) is the only markup injected here.
 */
export function CodeBlock({ code, lang, title }: { code: string; lang?: string; title?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, copy] = useCopy(code);

  useEffect(() => {
    setHtml(null);
    if (!lang) return;
    let live = true;
    import("shiki")
      .then(({ bundledLanguages, codeToHtml }) => {
        // Own-property check: names like `__proto__` would otherwise poison shiki's highlighter.
        if (!Object.hasOwn(bundledLanguages, lang)) return null;
        return codeToHtml(code, {
          lang,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
      })
      .then((out) => live && out !== null && setHtml(out))
      // Unknown language or load failure: keep the plain block.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, lang]);

  return (
    <div className="codeblock">
      <div className="cb-h">
        <span>{title ?? lang ?? "text"}</span>
        <button type="button" className="ib" onClick={copy}>
          {copied ? (
            <Check aria-hidden strokeWidth={1.75} />
          ) : (
            <Copy aria-hidden strokeWidth={1.75} />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html === null ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output, code is escaped by shiki
        <div className="shiki-wrap" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

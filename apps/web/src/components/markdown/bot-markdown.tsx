import { Check } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Callout } from "./callout";
import { CodeBlock } from "./code-block";
import { Diagram } from "./diagram";
import { remarkCallouts } from "./remark-callouts";
import { remarkTicketRefs } from "./remark-ticket-refs";
import { TicketLink } from "./ticket-link";

/** Structural view of the hast nodes the renderers read (avoids a direct `hast` dependency). */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  data?: { meta?: string | null };
  children?: HastNode[];
}

const TICKET_HREF = /^\/tickets\/(FRI-\d+)$/;

/** `title=name` or `title="a name"` from a fence info string. */
function fenceTitle(meta?: string | null): string | undefined {
  const m = meta && /title=(?:"([^"]+)"|(\S+))/.exec(meta);
  return m ? (m[1] ?? m[2]) : undefined;
}

/** `pre` renderer: a fence becomes a Diagram (mermaid) or a CodeBlock; anything else stays a `<pre>`. */
function Pre({ node, children }: { node?: HastNode; children?: ReactNode }) {
  const code = node?.children?.[0];
  if (code?.tagName !== "code") return <pre>{children}</pre>;
  const text = (code.children ?? [])
    .map((c) => c.value ?? "")
    .join("")
    .replace(/\n$/, "");
  const classes = Array.isArray(code.properties?.className)
    ? (code.properties.className as string[])
    : [];
  const lang = classes.find((c) => c.startsWith("language-"))?.slice(9);
  if (lang === "mermaid") return <Diagram source={text} />;
  return <CodeBlock code={text} lang={lang} title={fenceTitle(code.data?.meta)} />;
}

/** `a` renderer: ticket links stay in the app, absolute http(s) and protocol-relative links open in a new tab. */
function Link({ href, children }: ComponentProps<"a"> & { node?: unknown }) {
  const ticket = href ? TICKET_HREF.exec(href) : null;
  if (ticket?.[1]) return <TicketLink ticketRef={ticket[1]} />;
  if (href && /^(https?:)?\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return <a href={href}>{children}</a>;
}

/** Renderers: every other element uses react-markdown's safe default. */
const components: Components = {
  pre: Pre,
  a: Link,
  // Wide tables scroll inside their own box instead of widening the page.
  table: ({ node: _n, children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  // `> [!NOTE]` blockquotes were tagged by `remarkCallouts`.
  blockquote: ({ node: _n, children, ...rest }) => {
    const tone = (rest as { "data-callout"?: "info" | "risk" })["data-callout"];
    return tone ? <Callout tone={tone}>{children}</Callout> : <blockquote>{children}</blockquote>;
  },
  // Task lists: the prototype's green check boxes and struck-through done items.
  ul: ({ node: _n, className, children }) => (
    <ul className={className?.includes("contains-task-list") ? "tasks" : className}>{children}</ul>
  ),
  li: ({ node, className, children }) => {
    const input = (node as HastNode | undefined)?.children?.find((c) => c.tagName === "input");
    const done = className?.includes("task-list-item") && input?.properties?.checked === true;
    return <li className={done ? "done" : className}>{children}</li>;
  },
  // A real (disabled) checkbox for assistive tech, hidden visually; the span is the drawn box.
  input: ({ node: _n, type, checked }) =>
    type === "checkbox" ? (
      <>
        <input type="checkbox" className="cb-input" checked={!!checked} disabled readOnly />
        <span className={checked ? "cb on" : "cb"} aria-hidden>
          {checked && <Check strokeWidth={3} />}
        </span>
      </>
    ) : null,
};

/**
 * Renders untrusted bot text. No raw HTML (no rehype-raw), react-markdown's default
 * `urlTransform` drops `javascript:` / `data:` URLs; the only injected HTML is shiki / mermaid output.
 */
export function BotMarkdown({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        remarkPlugins={[remarkGfm, remarkTicketRefs, remarkCallouts]}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
}

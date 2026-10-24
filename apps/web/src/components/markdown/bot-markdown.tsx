import { Check } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, useContext } from "react";
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
  position?: { start: { line: number } };
  children?: HastNode[];
}

/** Task-box click handling of a caller: the toggle and which source lines hold a counted task. */
interface TaskToggleProps {
  onToggle: (line: number) => void;
  /** False for a box that maps to no counted task; it then stays disabled. */
  isTask: (line: number) => boolean;
}

/** Set by a caller that lets the reader tick task boxes: gets the 0-based source line of the box. */
const TaskToggle = createContext<TaskToggleProps | undefined>(undefined);

/** Source line (1-based) of the task item being rendered; the `input` node carries no position. */
const TaskLine = createContext<number | undefined>(undefined);

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

/**
 * Task-list box: a real checkbox for assistive tech (hidden visually) and the drawn box. Read-only
 * unless the page gave a `TaskToggle`; then a click on the box reports its source line.
 */
function TaskBox({ type, checked }: ComponentProps<"input"> & { node?: unknown }) {
  const toggle = useContext(TaskToggle);
  const line = useContext(TaskLine);
  if (type !== "checkbox") return null;
  const click =
    toggle && line && toggle.isTask(line - 1) ? () => toggle.onToggle(line - 1) : undefined;
  return (
    <>
      <input
        type="checkbox"
        className="cb-input"
        checked={!!checked}
        disabled={!click}
        onChange={click}
        readOnly={!click}
      />
      <span
        className={checked ? "cb on" : "cb"}
        data-chk={click ? "" : undefined}
        aria-hidden
        onClick={click}
      >
        {checked && <Check strokeWidth={3} />}
      </span>
    </>
  );
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
    const line = node?.position?.start.line;
    return (
      <li className={done ? "done" : className}>
        <TaskLine.Provider value={line}>{children}</TaskLine.Provider>
      </li>
    );
  },
  input: TaskBox,
};

/**
 * Renders untrusted bot text. No raw HTML (no rehype-raw), react-markdown's default
 * `urlTransform` drops `javascript:` / `data:` URLs; the only injected HTML is shiki / mermaid output.
 */
export function BotMarkdown({
  text,
  onToggleTask,
  isTaskLine = () => true,
}: {
  text: string;
  /** Makes task boxes clickable; called with the 0-based source line of the box. */
  onToggleTask?: (line: number) => void;
  /** Tells which 0-based source lines are counted tasks; other boxes stay disabled. */
  isTaskLine?: (line: number) => boolean;
}) {
  return (
    <div className="md">
      <TaskToggle.Provider value={onToggleTask && { onToggle: onToggleTask, isTask: isTaskLine }}>
        <Markdown
          remarkPlugins={[remarkGfm, remarkTicketRefs, remarkCallouts]}
          components={components}
        >
          {text}
        </Markdown>
      </TaskToggle.Provider>
    </div>
  );
}

import type { ReactNode } from "react";
import { Badge } from "../ui/badge";
import { useAppNavigate } from "./use-app-navigate";

/** What a row shows at its right edge. */
export type TrailingMark =
  | { kind: "approval" | "unread"; count: number }
  | { kind: "working" | "none" };

/** Priority: open approvals (amber) over unread (tint) over a "working" label. */
export function trailingMark(c: {
  approvals: number;
  unread: number;
  working: boolean;
}): TrailingMark {
  if (c.approvals > 0) return { kind: "approval", count: c.approvals };
  if (c.unread > 0) return { kind: "unread", count: c.unread };
  return { kind: c.working ? "working" : "none" };
}

/** The badge or label for a mark; `workingLabel` lets a group say "2 working". */
export function Trailing({ mark, workingLabel }: { mark: TrailingMark; workingLabel?: string }) {
  if (mark.kind === "approval") return <Badge tone="amber" count={mark.count} />;
  if (mark.kind === "unread") return <Badge tone="tint" count={mark.count} />;
  if (mark.kind === "working") return <span className="sub">{workingLabel ?? "working"}</span>;
  return null;
}

export interface SidebarRowProps {
  href: string;
  /** Selected: draws the `.sel` element that glides between rows (shared view transition). */
  on: boolean;
  children: ReactNode;
}

/** A 32 px sidebar link; navigation goes through the view-transition navigate. */
export function SidebarRow({ href, on, children }: SidebarRowProps) {
  const go = useAppNavigate();
  return (
    <a
      className={on ? "sb-row on" : "sb-row"}
      href={href}
      aria-current={on ? "page" : undefined}
      onClick={(e) => {
        // Let the browser handle new-tab clicks; everything else stays in the SPA.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(href);
      }}
    >
      {on && <span className="sel" />}
      {children}
    </a>
  );
}

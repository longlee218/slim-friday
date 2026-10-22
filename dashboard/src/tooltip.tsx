import { type ReactNode, useCallback, useState } from "react";

/** Where the tooltip sits: viewport coordinates of the pointer or the focused mark. */
interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

/**
 * One floating tooltip per chart. `bind(content)` returns the pointer and focus handlers for a mark, so hover and
 * keyboard focus show the same readout. Rendered `position: fixed`, flipped near the right and bottom edges.
 */
export function useTooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const hide = useCallback(() => setTip(null), []);
  const bind = (content: ReactNode) => ({
    onPointerMove: (e: React.PointerEvent) => setTip({ x: e.clientX, y: e.clientY, content }),
    onPointerLeave: hide,
    onFocus: (e: React.FocusEvent) => {
      const r = (e.currentTarget as Element).getBoundingClientRect();
      setTip({ x: r.left + r.width / 2, y: r.top, content });
    },
    onBlur: hide,
  });
  const node = tip ? (
    <div
      className="tooltip"
      role="tooltip"
      style={{
        left: tip.x > window.innerWidth - 300 ? tip.x - 14 : tip.x + 14,
        top: tip.y > window.innerHeight - 220 ? tip.y - 12 : tip.y + 16,
        transform: `translate(${tip.x > window.innerWidth - 300 ? "-100%" : "0"}, ${tip.y > window.innerHeight - 220 ? "-100%" : "0"})`,
      }}
    >
      {tip.content}
    </div>
  ) : null;
  return { bind, hide, node };
}

/** Tooltip body: a title, then rows of key line + value (strong) + label. */
export function TipBody({ title, rows, foot }: { title: ReactNode; rows: { color?: string; value: ReactNode; label: ReactNode }[]; foot?: ReactNode }) {
  return (
    <>
      <div className="tip-title">{title}</div>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
        <div className="tip-row" key={i}>
          {r.color && <i style={{ background: r.color }} />}
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
      {foot && <div className="tip-foot">{foot}</div>}
    </>
  );
}

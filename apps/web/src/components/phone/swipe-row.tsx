import { Trash2 } from "lucide-react";
import { type CSSProperties, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { ACTION_PX, type RowSwipe, rowSwipeStep, settlesOpen } from "./swipe-to-delete";

/** Touches this close to the left edge belong to the back swipe. */
const EDGE_PX = 30;

export interface SwipeRowProps {
  /** Whether the row rests open (controlled, so the list keeps one row open at a time). */
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The red Delete button was tapped. */
  onDelete(): void;
  /** A row that cannot be deleted never slides and has no button. */
  disabled?: boolean;
  children: ReactNode;
}

/**
 * Phone row with a swipe-left quick action: dragging the row left reveals a red Delete button.
 * A tap on an open row only closes it (it never opens the chat), as does a tap after a slide.
 */
export function SwipeRow({ open, onOpenChange, onDelete, disabled, children }: SwipeRowProps) {
  const [live, setLive] = useState<number | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const swipe = useRef<RowSwipe>({ phase: "idle", dx: 0 });
  const slid = useRef(false);
  if (disabled) return <>{children}</>;
  const rest = open ? -ACTION_PX : 0;

  const down = (e: PointerEvent) => {
    if (e.clientX < EDGE_PX) return;
    start.current = { x: e.clientX, y: e.clientY };
    swipe.current = { phase: "pressing", dx: rest };
    slid.current = false;
  };
  const move = (e: PointerEvent) => {
    const delta = { dx: e.clientX - start.current.x, dy: e.clientY - start.current.y };
    swipe.current = rowSwipeStep(swipe.current, delta, rest);
    if (swipe.current.phase !== "swiping") return;
    slid.current = true;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setLive(swipe.current.dx);
  };
  const end = () => {
    const s = swipe.current;
    swipe.current = { phase: "idle", dx: 0 };
    setLive(null);
    if (s.phase === "swiping") onOpenChange(settlesOpen(s.dx));
  };
  /** The click after a slide, or on an open row, must not open the chat. */
  const guard = (e: { preventDefault(): void; stopPropagation(): void }) => {
    if (!open && !slid.current) return;
    e.preventDefault();
    e.stopPropagation();
    slid.current = false;
    if (open) onOpenChange(false);
  };

  const dx = live ?? rest;
  return (
    <div
      className={`swrow${open ? " open" : ""}${live === null ? "" : " drag"}`}
      style={{ "--dx": `${dx}px` } as CSSProperties}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <button
        type="button"
        className="swrow-del"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onDelete}
      >
        <span>
          <Trash2 size={18} strokeWidth={1.75} />
          Delete
        </span>
      </button>
      <div className="swrow-slide" onClickCapture={guard}>
        {children}
      </div>
    </div>
  );
}

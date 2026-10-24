import { Dialog } from "@base-ui/react/dialog";
import { type PointerEvent, type ReactNode, useRef } from "react";

/** Drag distance (px) past which a release closes the sheet. */
const DISMISS_PX = 110;
/** Drag distance (px) at which the dim has fully faded. */
const DIM_FADE_PX = 400;

/** True when a downward drag of `dy` px is far enough to dismiss. */
export function shouldDismissSheet(dy: number): boolean {
  return dy > DISMISS_PX;
}

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * Phone bottom sheet (grab handle, 14 px top radius). Drag down to dismiss:
 * the sheet follows the finger and the dim fades as `1 - dy / 400`.
 */
export function BottomSheet({ open, onOpenChange, children }: BottomSheetProps) {
  const startY = useRef<number | null>(null);
  const dy = useRef(0);
  const dim = useRef<HTMLDivElement>(null);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    startY.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.currentTarget.style.transition = "none";
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (startY.current == null) return;
    dy.current = Math.max(0, e.clientY - startY.current);
    e.currentTarget.style.transform = `translateY(${dy.current}px)`;
    if (dim.current) dim.current.style.opacity = String(1 - dy.current / DIM_FADE_PX);
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (startY.current == null) return;
    startY.current = null;
    const el = e.currentTarget;
    el.style.transition = "";
    if (shouldDismissSheet(dy.current)) onOpenChange(false);
    else {
      // Snap back and restore the dim.
      el.style.transform = "";
      if (dim.current) dim.current.style.opacity = "";
    }
    dy.current = 0;
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dim" ref={dim} />
        <Dialog.Popup
          className="bsheet"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <div className="grab" />
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

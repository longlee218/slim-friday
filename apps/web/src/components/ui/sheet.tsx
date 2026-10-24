import { Dialog } from "@base-ui/react/dialog";
import type { ReactNode } from "react";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Wider panel for diagrams. */
  wide?: boolean;
  children: ReactNode;
}

/**
 * Desktop sheet that drops from the toolbar (500 px, 14 px bottom radius).
 * Base UI Dialog gives focus trap, Escape and outside click; the prototype CSS
 * (`.dim`, `.sheet`) gives the look and the exit animation via [data-ending-style].
 */
export function Sheet({ open, onOpenChange, wide, children }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dim" />
        <Dialog.Popup className={wide ? "sheet wide" : "sheet"}>{children}</Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

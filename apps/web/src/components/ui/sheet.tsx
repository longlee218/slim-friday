import { Dialog } from "@base-ui/react/dialog";
import { type ReactNode, useRef } from "react";
import { firstField } from "./bottom-sheet";

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Wider panel for diagrams. */
  wide?: boolean;
  children: ReactNode;
}

/**
 * Desktop sheet: a centred glass card. Base UI Dialog gives focus trap, Escape and outside
 * click; `.dim` and `.sheet` give the look and the exit animation via [data-ending-style]. A
 * `SheetForm` inside gets the Cancel | title | action bar, as on the phone.
 */
export function Sheet({ open, onOpenChange, wide, children }: SheetProps) {
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dim" />
        <Dialog.Popup
          ref={popup}
          className={wide ? "sheet wide" : "sheet"}
          initialFocus={(openType) => firstField(popup.current, openType)}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

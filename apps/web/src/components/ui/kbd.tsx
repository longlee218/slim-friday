import type { ReactNode } from "react";

/** Keyboard hint chip, e.g. the shortcut next to a search field. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

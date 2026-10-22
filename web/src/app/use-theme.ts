import { useCallback, useState } from "react";
import { useMediaQuery } from "./use-media-query";
import { revealTheme } from "./view-transition";

type Theme = "light" | "dark";
const KEY = "friday.theme";

/** Read the saved theme; storage can be blocked, so failures mean "follow the system". */
function saved(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** System appearance by default; the toggle pins light or dark on <html data-theme>. */
export function useTheme(): { dark: boolean; toggle(x: number, y: number): void } {
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [choice, setChoice] = useState<Theme | null>(() => {
    const t = saved();
    if (t) document.documentElement.dataset.theme = t;
    return t;
  });
  const dark = choice ? choice === "dark" : systemDark;

  // The new theme grows as a circle from the button (x, y).
  const toggle = useCallback((x: number, y: number) => {
    const next: Theme = dark ? "light" : "dark";
    revealTheme(x, y, () => {
      document.documentElement.dataset.theme = next;
      setChoice(next);
    });
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
  }, [dark]);

  return { dark, toggle };
}

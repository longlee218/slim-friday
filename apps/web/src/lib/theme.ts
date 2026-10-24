/** Owner theme choice: follow the OS, or force light or dark. */
export type Theme = "system" | "light" | "dark";

/** Sets `data-theme` on <html> for light/dark; "system" removes it so the media query decides. */
export function setTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = t;
}

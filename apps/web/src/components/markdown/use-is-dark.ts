import { useEffect, useState } from "react";

const QUERY = "(prefers-color-scheme: dark)";

/** Dark when `<html data-theme>` says so, or (no explicit theme) when the OS prefers dark. */
function readDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === "dark";
  return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
}

/** Live dark-mode flag: follows `data-theme` changes and the OS media query; cleans up on unmount. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(readDark);
  useEffect(() => {
    const update = () => setDark(readDark());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
    mq?.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      mq?.removeEventListener("change", update);
    };
  }, []);
  return dark;
}

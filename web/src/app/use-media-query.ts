import { useSyncExternalStore } from "react";

/** Live match of a CSS media query. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

export const PHONE = "(max-width: 720px)";
export const NARROW = "(max-width: 1100px)";

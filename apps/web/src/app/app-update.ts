/**
 * When the installed app picks up a new version. An iPhone home-screen app resumes from memory
 * instead of reloading, so the service worker is asked for updates whenever the app is shown or
 * hidden (and hourly), and a waiting version is applied by a reload only at a safe moment:
 * unsent drafts live in memory and a reload would drop them.
 */

/** A page this young (ms) cannot hold a draft yet. */
const FRESH_MS = 10_000;
/** How often (ms) a long-open app asks for a new version. */
const CHECK_EVERY_MS = 60 * 60 * 1000;

/** True while a text field has focus: the owner may be typing. */
function editing(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el as HTMLElement | null)?.isContentEditable === true
  );
}

/**
 * Calls `apply` (the reload into the new version) now when the app is hidden, or when the page is
 * younger than 10 s and nothing is being typed; otherwise once, the next time the app is hidden.
 * `sinceLoadMs` is the page age (`performance.now()`).
 */
export function applyWhenSafe(apply: () => void, sinceLoadMs = performance.now()): void {
  if (document.visibilityState === "hidden" || (sinceLoadMs < FRESH_MS && !editing())) {
    apply();
    return;
  }
  const onHide = () => {
    if (document.visibilityState !== "hidden") return;
    document.removeEventListener("visibilitychange", onHide);
    apply();
  };
  document.addEventListener("visibilitychange", onHide);
}

/** Runs `check` (ask the service worker for a new version) on every show or hide and hourly; returns a stop function. */
export function watchForUpdates(check: () => void): () => void {
  document.addEventListener("visibilitychange", check);
  const timer = setInterval(check, CHECK_EVERY_MS);
  return () => {
    document.removeEventListener("visibilitychange", check);
    clearInterval(timer);
  };
}

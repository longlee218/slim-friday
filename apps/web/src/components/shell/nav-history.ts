const DEFAULT_CHAT = "/c/bot:friday";
const isChat = (path: string) => path.startsWith("/c/");

export interface NavHistory {
  /** Record a visit; entries ahead of the current one are dropped. */
  push(path: string): void;
  /** Step back; the new current path, or null at the start. */
  /**
   * Align with the URL after any navigation: same path is a no-op, the previous / next entry
   * moves the cursor, anything else is a new visit.
   */
  sync(path: string): void;
  back(): string | null;
  /** Step forward; the new current path, or null at the end. */
  forward(): string | null;
  readonly canBack: boolean;
  readonly canForward: boolean;
  /** The last visited `/c/:id` (⌘1); defaults to the Friday chat. */
  readonly lastChat: string;
  /** Bumps on every change, for `useSyncExternalStore`. */
  readonly version: number;
  subscribe(listener: () => void): () => void;
  /** Start over from one path (tests, sign-out). */
  reset(initial: string): void;
}

/** Window-style history (back/forward buttons) kept apart from the browser's own stack. */
export function createNavHistory(initial: string): NavHistory {
  let entries = [initial];
  let index = 0;
  let lastChat = isChat(initial) ? initial : DEFAULT_CHAT;
  let version = 0;
  const listeners = new Set<() => void>();

  // Every mutation ends here: remember the chat and tell subscribers.
  const changed = () => {
    if (isChat(entries[index])) lastChat = entries[index];
    version += 1;
    for (const l of listeners) l();
  };
  const move = (to: number): string | null => {
    if (to < 0 || to >= entries.length) return null;
    index = to;
    changed();
    return entries[index];
  };

  return {
    push(path) {
      if (entries[index] === path) return;
      entries = [...entries.slice(0, index + 1), path];
      index = entries.length - 1;
      changed();
    },
    sync(path) {
      if (entries[index] === path) return;
      if (entries[index - 1] === path) move(index - 1);
      else if (entries[index + 1] === path) move(index + 1);
      else this.push(path);
    },
    back: () => move(index - 1),
    forward: () => move(index + 1),
    get canBack() {
      return index > 0;
    },
    get canForward() {
      return index < entries.length - 1;
    },
    get lastChat() {
      return lastChat;
    },
    get version() {
      return version;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset(path) {
      entries = [path];
      index = 0;
      lastChat = isChat(path) ? path : DEFAULT_CHAT;
      changed();
    },
  };
}

/** The app-wide history, seeded with the page the app was opened on. */
export const navHistory = createNavHistory(window.location.pathname);

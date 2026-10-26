/** The four tabs of the phone tab bar. */
export type PhoneTab = "chats" | "tickets" | "activity" | "settings";

/** The route each tab opens on; a path equal to one of these is a stack root. */
export const TAB_ROOT: Record<PhoneTab, string> = {
  chats: "/",
  tickets: "/tickets",
  activity: "/ops",
  settings: "/settings",
};

const ROOTS = new Set<string>(Object.values(TAB_ROOT));

/**
 * The tab a path belongs to (`/c/*` is a chat, so chats; schedules and files live in Settings; unknown
 * paths fall back to chats).
 */
export function tabOf(path: string): PhoneTab {
  switch (path.split("/")[1]) {
    case "tickets":
      return "tickets";
    case "ops":
      return "activity";
    case "settings":
    case "schedules":
    case "files":
      return "settings";
    default:
      return "chats";
  }
}

/**
 * The stack for a path opened cold (page load, crossing from desktop): its tab root, then the
 * path. A schedule sits on the schedules list, so its back button reads "Schedules".
 */
export function phoneStackFor(path: string): string[] {
  const root = TAB_ROOT[tabOf(path)];
  if (path === root) return [root];
  if (path.startsWith("/schedules/")) return [root, "/schedules", path];
  return [root, path];
}

/** One router navigation as the phone sees it. */
export interface PhoneNav {
  type: "PUSH" | "POP" | "REPLACE";
  path: string;
}

/**
 * Next stack after a navigation. A tab root always resets the stack (tab switch). Otherwise:
 * PUSH appends; POP drops back to the entry equal to `path` (reseeds when it is absent);
 * REPLACE swaps the top, or steps back when `path` is the entry underneath (the back button of
 * a view that was opened cold has no history to pop).
 */
export function phoneStackReduce(stack: string[], { type, path }: PhoneNav): string[] {
  if (ROOTS.has(path)) return [path];
  if (type === "PUSH") return stack.at(-1) === path ? stack : [...stack, path];
  if (type === "POP") {
    const at = stack.lastIndexOf(path);
    return at >= 0 ? stack.slice(0, at + 1) : phoneStackFor(path);
  }
  if (stack.length < 2) return phoneStackFor(path);
  if (stack.at(-2) === path) return stack.slice(0, -1);
  return [...stack.slice(0, -1), path];
}

/** Label of the back button of the top view: names the view underneath it. */
export function backLabel(stack: string[]): string {
  const under = stack.at(-2) ?? "";
  if (under.startsWith("/c/")) return "Chat";
  if (under === "/") return "Chats";
  if (under === "/settings") return "Settings";
  if (under === "/tickets") return "Tickets";
  if (under === "/schedules") return "Schedules";
  return "Back";
}

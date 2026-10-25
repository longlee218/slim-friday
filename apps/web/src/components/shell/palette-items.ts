import type { Directory } from "../../api/directory";

/** What an item can do when run: go somewhere, or stop every working bot. */
export interface PaletteContext {
  navigate(to: string): void;
  stopAll(): Promise<void>;
  /** Opens the new-ticket sheet. */
  newTicket(): void;
}

/** One row of the command palette. `icon` is a key of the icon map in `command-palette.tsx`. */
export interface PaletteItem {
  group: "Bots" | "Groups" | "Actions" | "Settings";
  label: string;
  /** Muted text after the label (a bot's title, a group's member count). */
  sub?: string;
  icon?: string;
  /** Face URL; set (even to "") for a bot row so it shows an avatar instead of an icon. */
  avatar?: string;
  /** Hint at the right edge; the global shortcut exists already, this only shows it. */
  shortcut?: string;
  run: (ctx: PaletteContext) => void;
}

/** A row that opens a route. */
const go = (
  group: PaletteItem["group"],
  label: string,
  icon: string,
  to: string,
  shortcut?: string,
): PaletteItem => ({ group, label, icon, shortcut, run: (ctx) => ctx.navigate(to) });

/** Extra rows other plans append (plan 4 adds "New ticket" `⌘N`); listed after the built-in actions. */
export const EXTRA_PALETTE_ITEMS: PaletteItem[] = [
  {
    group: "Actions",
    label: "New ticket",
    icon: "plus",
    shortcut: "⌘N",
    run: (ctx) => ctx.newTicket(),
  },
];

/** Every palette row for the current bots and groups: Bots, Groups, Actions, Settings. */
export function paletteItems(dir: Directory): PaletteItem[] {
  const bots = [...dir.bots.values()].map<PaletteItem>((b) => ({
    group: "Bots",
    label: b.name,
    sub: b.title || undefined,
    avatar: b.avatarUrl ?? "",
    run: (ctx) => ctx.navigate(`/c/bot:${b.id}`),
  }));
  const groups = [...dir.groups.values()].map<PaletteItem>((g) => ({
    group: "Groups",
    label: g.name,
    sub: `${g.members.length} members`,
    icon: "users",
    avatar: undefined,
    run: (ctx) => ctx.navigate(`/c/group:${g.id}`),
  }));
  return [
    ...bots,
    ...groups,
    go("Actions", "Open tickets", "square-kanban", "/tickets", "⌘2"),
    go("Actions", "Open activity", "gauge", "/ops", "⌘3"),
    {
      group: "Actions",
      label: "Stop every bot",
      icon: "circle-stop",
      run: (ctx) => void ctx.stopAll(),
    },
    ...EXTRA_PALETTE_ITEMS,
    go("Settings", "About you (USER.md)", "user-round", "/settings/owner/user"),
    go("Settings", "Personality (SOUL.md)", "sparkles", "/settings/owner/soul"),
    go("Settings", "MCP servers", "plug", "/settings/mcp"),
    go("Settings", "Skills & plugins", "puzzle", "/settings/skills"),
  ];
}

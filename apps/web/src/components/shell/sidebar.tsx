import {
  Bot,
  CalendarClock,
  Gauge,
  Search,
  Settings,
  SquareKanban,
  SquarePen,
  UsersRound,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useLocation } from "react-router";
import { enabledCount, useSchedules } from "../schedules/use-schedules";
import { openCount, useAllTickets } from "../tickets/use-tickets";
import { IconButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { ChatRow, useChatRows } from "./chat-rows";
import { useAppNavigate } from "./use-app-navigate";

/** Chat list filters (Messenger's chips). */
const FILTERS = ["All", "Bots", "Groups"] as const;
type Filter = (typeof FILTERS)[number];

/** A round workspace link in the dock, with its count as a small badge. */
function DockLink({
  href,
  label,
  on,
  count,
  children,
}: {
  href: string;
  label: string;
  on: boolean;
  count?: number;
  children: ReactNode;
}) {
  const go = useAppNavigate();
  return (
    <a
      className={on ? "dock-btn on" : "dock-btn"}
      href={href}
      aria-label={label}
      title={label}
      aria-current={on ? "page" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(href);
      }}
    >
      {children}
      {count ? <span className="dock-count num">{count}</span> : null}
    </a>
  );
}

/** A dashed-face row that starts a new bot or group. */
function AddRow({ label, icon, onClick }: { label: string; icon: ReactNode; onClick(): void }) {
  return (
    <button type="button" className="crow add" onClick={onClick}>
      <span className="add-face">{icon}</span>
      <span className="grow">
        <b>{label}</b>
      </span>
    </button>
  );
}

/**
 * Left pane, Messenger style: "Chats" with New chat, the search pill (opens the palette), filter
 * chips, every bot and group chat newest first, the add rows, and a dock with the workspace pages.
 */
export function Sidebar({ onPalette }: { onPalette: () => void }) {
  const go = useAppNavigate();
  const { pathname } = useLocation();
  const rows = useChatRows();
  const { tickets } = useAllTickets();
  const { schedules } = useSchedules();
  const [filter, setFilter] = useState<Filter>("All");
  const shown = rows.filter(
    (r) => filter === "All" || (filter === "Bots" ? r.kind === "bot" : r.kind === "group"),
  );

  return (
    <>
      <div className="sb-top">
        <h2 className="sb-title">Chats</h2>
        <IconButton label="New chat" onClick={onPalette}>
          <SquarePen size={17} strokeWidth={1.75} />
        </IconButton>
      </div>
      <div className="sb-search">
        <Search strokeWidth={1.75} />
        <input className="field" placeholder="Search" readOnly onClick={onPalette} />
        <Kbd>⌘K</Kbd>
      </div>
      <div className="sb-chips" role="tablist" aria-label="Show">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            className={filter === f ? "chip on" : "chip"}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="sb-scroll">
        {shown.map((r) => (
          <ChatRow key={r.id} row={r} size={44} on={pathname === `/c/${r.id}`} onOpen={go} />
        ))}
        {filter !== "Groups" && (
          <AddRow
            label="New bot"
            icon={<Bot size={18} strokeWidth={1.75} />}
            onClick={() => go("/settings/bot/new")}
          />
        )}
        {filter !== "Bots" && (
          <AddRow
            label="New group"
            icon={<UsersRound size={18} strokeWidth={1.75} />}
            onClick={() => go("/settings/group/new")}
          />
        )}
      </div>
      <nav className="sb-dock" aria-label="Workspace">
        <a
          className="me"
          href="/settings/account"
          aria-label="Owner"
          title="Owner"
          onClick={(e) => {
            e.preventDefault();
            go("/settings/account");
          }}
        >
          <span className="initial">O</span>
        </a>
        <DockLink
          href="/tickets"
          label="Tickets"
          on={pathname.startsWith("/tickets")}
          count={openCount(tickets)}
        >
          <SquareKanban size={18} strokeWidth={1.75} />
        </DockLink>
        <DockLink
          href="/schedules"
          label="Schedules"
          on={pathname.startsWith("/schedules")}
          count={enabledCount(schedules)}
        >
          <CalendarClock size={18} strokeWidth={1.75} />
        </DockLink>
        <DockLink href="/ops" label="Activity" on={pathname.startsWith("/ops")}>
          <Gauge size={18} strokeWidth={1.75} />
        </DockLink>
        <DockLink href="/settings" label="Settings" on={pathname.startsWith("/settings")}>
          <Settings size={18} strokeWidth={1.75} />
        </DockLink>
      </nav>
    </>
  );
}

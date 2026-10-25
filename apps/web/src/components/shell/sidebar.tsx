import { useQuery } from "@tanstack/react-query";
import {
  CalendarClock,
  Ellipsis,
  Fingerprint,
  Gauge,
  Plus,
  Search,
  Settings,
  SquareKanban,
  SquarePen,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { useLocation } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { enabledCount, useSchedules } from "../schedules/use-schedules";
import { GroupAvatar } from "../settings/group-avatar";
import { openCount, useAllTickets } from "../tickets/use-tickets";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { SidebarRow, Trailing, trailingMark } from "./sidebar-row";
import { useAppNavigate } from "./use-app-navigate";

/** Bots listed before the "N more" row; a hidden bot that is open or has a mark still shows. */
const SHOWN_BOTS = 7;

/** The icon cell of a workspace row. */
const Ico = ({ children }: { children: ReactNode }) => <span className="sb-ico">{children}</span>;

/** Section title with the hover "+" button. */
function Section({ title, add, onAdd }: { title: string; add?: string; onAdd?: () => void }) {
  return (
    <div className="sb-sec">
      {title}
      {add && (
        <IconButton label={add} onClick={onAdd}>
          <Plus size={15} strokeWidth={1.75} />
        </IconButton>
      )}
    </div>
  );
}

/**
 * Left column: brand, New chat, search (both open the palette), bots, groups, workspace rows and
 * the owner footer. Counts come from the cache: server unread as is (it already includes open
 * cards) and the open approvals per conversation.
 */
export function Sidebar({ onPalette }: { onPalette: () => void }) {
  const go = useAppNavigate();
  const { pathname } = useLocation();
  const { bots, groups, conversations } = useDirectory();
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];

  const { tickets } = useAllTickets();
  const open = openCount(tickets);
  const { schedules } = useSchedules();
  const working = new Set(status.filter((s) => s.working).map((s) => s.botId));
  const unread = (id: string) => conversations.find((c) => c.id === id)?.unread ?? 0;
  const pending = (id: string) => approvals.filter((a) => a.conversationId === id).length;
  const [allBots, setAllBots] = useState(false);

  // Each bot row with its mark; past SHOWN_BOTS only the open one or one with a mark stays.
  const botRows = [...bots.values()].map((b, i) => {
    const id = `bot:${b.id}`;
    const mark = trailingMark({
      approvals: pending(id),
      unread: unread(id),
      working: working.has(b.id),
    });
    const on = pathname === `/c/${id}`;
    return { b, id, mark, on, shown: allBots || i < SHOWN_BOTS || on || mark.kind !== "none" };
  });
  const hidden = botRows.filter((r) => !r.shown).length;

  return (
    <>
      <div className="sb-top">
        <span className="brand">
          <Avatar name="Friday" size={22} />
          Friday
        </span>
        <IconButton label="New chat" onClick={onPalette}>
          <SquarePen size={16} strokeWidth={1.75} />
        </IconButton>
      </div>
      <div className="sb-search">
        <Search strokeWidth={1.75} />
        <input className="field" placeholder="Search" readOnly onClick={onPalette} />
        <Kbd>⌘K</Kbd>
      </div>
      <div className="sb-scroll">
        <Section title="Bots" add="New bot" onAdd={() => go("/settings/bot/new")} />
        {botRows
          .filter((r) => r.shown)
          .map(({ b, id, mark, on }) => (
            <SidebarRow key={id} href={`/c/${id}`} on={on}>
              <Avatar src={b.avatarUrl} name={b.name} size={22} working={working.has(b.id)} />
              <span className="name">{b.name}</span>
              <Trailing mark={mark} />
            </SidebarRow>
          ))}
        {hidden > 0 && (
          <button type="button" className="sb-row more" onClick={() => setAllBots(true)}>
            <Ico>
              <Ellipsis size={16} strokeWidth={1.75} />
            </Ico>
            <span className="name">{`${hidden} more`}</span>
          </button>
        )}
        <Section title="Groups" add="New group" onAdd={() => go("/settings/group/new")} />
        {[...groups.values()].map((g) => {
          const id = `group:${g.id}`;
          const busy = g.members.filter((m) => working.has(m)).length;
          const mark = trailingMark({
            approvals: pending(id),
            unread: unread(id),
            working: busy > 0,
          });
          return (
            <SidebarRow key={id} href={`/c/${id}`} on={pathname === `/c/${id}`}>
              <GroupAvatar {...g} bots={bots} size={22} />
              <span className="name">{g.name}</span>
              <Trailing mark={mark} workingLabel={`${busy} working`} />
            </SidebarRow>
          );
        })}
        <Section title="Workspace" />
        <SidebarRow href="/tickets" on={pathname.startsWith("/tickets")}>
          <Ico>
            <SquareKanban size={16} strokeWidth={1.75} />
          </Ico>
          <span className="name">Tickets</span>
          <span className="sub num">{open}</span>
        </SidebarRow>
        <SidebarRow href="/schedules" on={pathname.startsWith("/schedules")}>
          <Ico>
            <CalendarClock size={16} strokeWidth={1.75} />
          </Ico>
          <span className="name">Schedules</span>
          <span className="sub num">{enabledCount(schedules)}</span>
        </SidebarRow>
        <SidebarRow href="/ops" on={pathname.startsWith("/ops")}>
          <Ico>
            <Gauge size={16} strokeWidth={1.75} />
          </Ico>
          <span className="name">Activity</span>
        </SidebarRow>
        <SidebarRow href="/settings" on={pathname.startsWith("/settings")}>
          <Ico>
            <Settings size={16} strokeWidth={1.75} />
          </Ico>
          <span className="name">Settings</span>
        </SidebarRow>
      </div>
      <div className="sb-foot">
        <a
          className="me"
          href="/settings/account"
          onClick={(e) => {
            e.preventDefault();
            go("/settings/account");
          }}
        >
          <span className="initial">O</span>
          <span style={{ flex: 1 }}>Owner</span>
          <Fingerprint size={16} strokeWidth={1.75} />
        </a>
      </div>
    </>
  );
}

import { useQuery } from "@tanstack/react-query";
import {
  Fingerprint,
  Gauge,
  Plus,
  Search,
  Settings,
  SquareKanban,
  SquarePen,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { SidebarRow, Trailing, trailingMark } from "./sidebar-row";
import { useAppNavigate } from "./use-app-navigate";

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

  const working = new Set(status.filter((s) => s.working).map((s) => s.botId));
  const unread = (id: string) => conversations.find((c) => c.id === id)?.unread ?? 0;
  const pending = (id: string) => approvals.filter((a) => a.conversationId === id).length;

  return (
    <aside className="sidebar">
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
        {[...bots.values()].map((b) => {
          const id = `bot:${b.id}`;
          const mark = trailingMark({
            approvals: pending(id),
            unread: unread(id),
            working: working.has(b.id),
          });
          return (
            <SidebarRow key={id} href={`/c/${id}`} on={pathname === `/c/${id}`}>
              <Avatar src={b.avatarUrl} name={b.name} size={22} />
              <span className="name">{b.name}</span>
              <Trailing mark={mark} />
            </SidebarRow>
          );
        })}
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
              {g.avatarUrl ? (
                <Avatar src={g.avatarUrl} name={g.name} size={22} />
              ) : (
                <Ico>
                  <Users size={16} strokeWidth={1.75} />
                </Ico>
              )}
              <span className="name">{g.name}</span>
              <Trailing mark={mark} workingLabel={`${busy} working`} />
            </SidebarRow>
          );
        })}
        <Section title="Workspace" />
        {/* Open-ticket count arrives with plan 4. */}
        <SidebarRow href="/tickets" on={pathname.startsWith("/tickets")}>
          <Ico>
            <SquareKanban size={16} strokeWidth={1.75} />
          </Ico>
          <span className="name">Tickets</span>
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
    </aside>
  );
}

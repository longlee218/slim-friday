import { useQuery } from "@tanstack/react-query";
import { KeyRound, Plug, Plus, Puzzle, Sparkles, UserRound, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { SidebarRow } from "../shell/sidebar-row";
import { Avatar } from "../ui/avatar";

const Ico = ({ children }: { children: ReactNode }) => <span className="sb-ico">{children}</span>;

/** The left column of Settings on desktop (prototype `.set-list`): bots, groups, connections, you. */
export function SettingsList() {
  const { pathname } = useLocation();
  const dir = useDirectory();
  const skills = useQuery(orpc.config.skills.list.queryOptions()).data;
  const servers = useQuery(orpc.config.mcp.list.queryOptions()).data;
  // Moving to another bot keeps the tab (Tools & skills stays Tools & skills).
  const tab = /^\/settings\/bot\/[^/]+\/(\w+)/.exec(pathname)?.[1] ?? "profile";
  const on = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

  return (
    <div className="set-list">
      <div className="sb-sec">Bots</div>
      {[...dir.bots.values()].map((b) => (
        <SidebarRow
          key={b.id}
          href={`/settings/bot/${b.id}/${tab}`}
          on={on(`/settings/bot/${b.id}`)}
        >
          <Avatar src={b.avatarUrl} name={b.name} size={22} />
          <span className="name">{b.name}</span>
          <span className="sub">{b.title}</span>
        </SidebarRow>
      ))}
      <SidebarRow href="/settings/bot/new" on={on("/settings/bot/new")}>
        <Ico>
          <Plus size={16} strokeWidth={1.75} />
        </Ico>
        <span className="name">New bot</span>
      </SidebarRow>
      <div className="sb-sec">Groups</div>
      {[...dir.groups.values()].map((g) => (
        <SidebarRow key={g.id} href={`/settings/group/${g.id}`} on={on(`/settings/group/${g.id}`)}>
          {g.avatarUrl ? (
            <Avatar src={g.avatarUrl} name={g.name} size={22} />
          ) : (
            <Ico>
              <Users size={16} strokeWidth={1.75} />
            </Ico>
          )}
          <span className="name">{g.name}</span>
        </SidebarRow>
      ))}
      <SidebarRow href="/settings/group/new" on={on("/settings/group/new")}>
        <Ico>
          <Plus size={16} strokeWidth={1.75} />
        </Ico>
        <span className="name">New group</span>
      </SidebarRow>
      <div className="sb-sec">Connections</div>
      <SidebarRow href="/settings/mcp" on={on("/settings/mcp")}>
        <Ico>
          <Plug size={16} strokeWidth={1.75} />
        </Ico>
        <span className="name">MCP servers</span>
        <span className="count">{servers?.length}</span>
      </SidebarRow>
      <SidebarRow href="/settings/skills" on={on("/settings/skills")}>
        <Ico>
          <Puzzle size={16} strokeWidth={1.75} />
        </Ico>
        <span className="name">Skills & plugins</span>
        <span className="count">{skills?.length}</span>
      </SidebarRow>
      <div className="sb-sec">You</div>
      <SidebarRow href="/settings/owner/user" on={on("/settings/owner/user")}>
        <Ico>
          <UserRound size={16} strokeWidth={1.75} />
        </Ico>
        <span className="name">About you</span>
        <span className="sub mono">USER.md</span>
      </SidebarRow>
      <SidebarRow href="/settings/owner/soul" on={on("/settings/owner/soul")}>
        <Ico>
          <Sparkles size={16} strokeWidth={1.75} />
        </Ico>
        <span className="name">Personality</span>
        <span className="sub mono">SOUL.md</span>
      </SidebarRow>
      <SidebarRow href="/settings/account" on={on("/settings/account")}>
        <Ico>
          <KeyRound size={16} strokeWidth={1.75} />
        </Ico>
        <span className="name">Account</span>
      </SidebarRow>
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  Fingerprint,
  Plug,
  Plus,
  Puzzle,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, Navigate } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { useIsPhone } from "../../app/use-is-phone";
import { Avatar } from "../ui/avatar";
import { GroupAvatar } from "./group-avatar";
import { SettingsPage } from "./settings-page";

/** A 44 px row that opens `to` (an `<a>` so it also opens in a new tab). */
function Row({
  to,
  icon,
  color,
  children,
  value,
}: {
  to: string;
  icon?: ReactNode;
  color?: string;
  children: ReactNode;
  value?: ReactNode;
}) {
  return (
    <Link className={icon || color ? "irow ic" : "irow"} to={to}>
      {color && icon && (
        <span className="sq" style={{ background: color }}>
          {icon}
        </span>
      )}
      {!color && icon}
      <div className="grow">{children}</div>
      {value !== undefined && <span className="v">{value}</span>}
      <ChevronRight className="chev" />
    </Link>
  );
}

const ic = { size: 17, strokeWidth: 1.75 } as const;

/** The phone Settings tab: Bots, Groups, MCP servers, Skills, Approval rules, then the owner files and account. */
export function PhoneSettingsRoot() {
  const dir = useDirectory();
  const skills = useQuery(orpc.config.skills.list.queryOptions()).data;
  const servers = useQuery(orpc.config.mcp.list.queryOptions()).data;
  return (
    <SettingsPage title="Settings" inset>
      <div className="inset">
        <Row
          to="/settings/bots"
          color="var(--tint-fill)"
          icon={<Bot {...ic} />}
          value={dir.bots.size}
        >
          Bots
        </Row>
        <Row to="/settings/groups" color="#34c759" icon={<Users {...ic} />} value={dir.groups.size}>
          Groups
        </Row>
        <Row to="/settings/mcp" color="#ff9f0a" icon={<Plug {...ic} />} value={servers?.length}>
          MCP servers
        </Row>
        <Row to="/settings/skills" color="#af52de" icon={<Puzzle {...ic} />} value={skills?.length}>
          Skills & plugins
        </Row>
        <Row to="/settings/approvals" color="#30b0c7" icon={<ShieldCheck {...ic} />}>
          Approval rules
        </Row>
      </div>
      <div className="inset-h">You</div>
      <div className="inset">
        <Row to="/settings/owner/user" color="#007aff" icon={<UserRound {...ic} />} value="USER.md">
          About you
        </Row>
        <Row to="/settings/owner/soul" color="#af52de" icon={<Sparkles {...ic} />} value="SOUL.md">
          Personality
        </Row>
        <Row to="/settings/account" color="#8e8e93" icon={<Fingerprint {...ic} />}>
          Account
        </Row>
      </div>
    </SettingsPage>
  );
}

/** Phone page listing the bots; a row opens the bot's page, the last row a new one. */
export function PhoneBotsList() {
  const dir = useDirectory();
  const phone = useIsPhone();
  if (!phone) return <Navigate to="/settings" replace />;
  return (
    <SettingsPage title="Bots" inset>
      <div className="inset">
        {[...dir.bots.values()].map((b) => (
          <Row
            key={b.id}
            to={`/settings/bot/${b.id}/profile`}
            icon={<Avatar src={b.avatarUrl} name={b.name} size={30} />}
          >
            <div>{b.name}</div>
            <div className="t2">{[b.title, b.model].filter(Boolean).join(" · ")}</div>
          </Row>
        ))}
        <Row to="/settings/bot/new" icon={<Plus {...ic} />}>
          New bot
        </Row>
      </div>
    </SettingsPage>
  );
}

/** Phone page listing the groups. */
export function PhoneGroupsList() {
  const dir = useDirectory();
  const phone = useIsPhone();
  if (!phone) return <Navigate to="/settings" replace />;
  return (
    <SettingsPage title="Groups" inset>
      <div className="inset">
        {[...dir.groups.values()].map((g) => (
          <Row
            key={g.id}
            to={`/settings/group/${g.id}`}
            icon={<GroupAvatar {...g} bots={dir.bots} size={30} />}
          >
            <div>{g.name}</div>
            <div className="t2">
              {g.members.length} members · entry {dir.botName(g.entryBot)}
            </div>
          </Row>
        ))}
        <Row to="/settings/group/new" icon={<Plus {...ic} />}>
          New group
        </Row>
      </div>
    </SettingsPage>
  );
}

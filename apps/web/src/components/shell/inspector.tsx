import type { BotDto, BotStatusDto, GroupDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { CircleStop, LoaderCircle, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { formatCost } from "../../lib/format";
import { conversationParts } from "../chat/conversation-parts";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { Pill } from "../ui/pill";
import { useAppNavigate } from "./use-app-navigate";
import { useStopRun } from "./use-stop-run";

/** One titled block of the inspector; plans 4-5 add open tickets and memory with it. */
export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="insp-sec">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A label / value row. */
const Prop = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="prop">
    <span>{label}</span>
    <span className="num">{children}</span>
  </div>
);

/** Bot inspector: hero with Edit and Stop, what it is doing now, and its settings. */
function BotInspector({ bot, status }: { bot: BotDto; status?: BotStatusDto }) {
  const go = useAppNavigate();
  const stop = useStopRun();
  const working = status?.working ?? false;
  return (
    <>
      <div className="insp-hero">
        <Avatar src={bot.avatarUrl} name={bot.name} size={72} working={working} />
        <h2>{bot.name}</h2>
        <div className="r">{`${bot.title} · ${bot.model}`}</div>
        <div className="insp-actions">
          <Button onClick={() => go(`/settings/bot/${bot.id}`)}>
            <SlidersHorizontal strokeWidth={1.75} />
            Edit
          </Button>
          <Button variant="danger" disabled={!working} onClick={() => void stop({ botId: bot.id })}>
            <CircleStop strokeWidth={1.75} />
            Stop
          </Button>
        </div>
      </div>
      <InspectorSection title="Now">
        {working ? (
          <div className="task" style={{ padding: "6px 0" }}>
            <LoaderCircle className="spin" strokeWidth={1.75} />
            <div className="grow">
              <div className="t1">{status?.label || "Working"}</div>
              {status?.tasks.map((t) => (
                <div key={t.id} className="t2">
                  {t.description}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--label-2)" }}>Idle</div>
        )}
      </InspectorSection>
      <InspectorSection title="About">
        <Prop label="Effort">{bot.effort ?? "Default"}</Prop>
        <Prop label="Spend today">{formatCost(status?.spendToday ?? 0)}</Prop>
      </InspectorSection>
    </>
  );
}

/** Group inspector: name, Edit, and the members with the entry bot marked. */
function GroupInspector({ group, status }: { group: GroupDto; status: BotStatusDto[] }) {
  const go = useAppNavigate();
  const dir = useDirectory();
  return (
    <>
      <div className="insp-hero">
        <span className="stack">
          {group.members.map((id) => (
            <Avatar key={id} src={dir.bots.get(id)?.avatarUrl} name={dir.botName(id)} size={40} />
          ))}
        </span>
        <h2 style={{ marginTop: 8 }}>{group.name}</h2>
        <div className="insp-actions">
          <Button onClick={() => go(`/settings/group/${group.id}`)}>
            <SlidersHorizontal strokeWidth={1.75} />
            Edit
          </Button>
        </div>
      </div>
      <InspectorSection title="Members">
        {group.members.map((id) => {
          const s = status.find((b) => b.botId === id);
          return (
            <div key={id} className="member">
              <Avatar src={dir.bots.get(id)?.avatarUrl} name={dir.botName(id)} size={26} />
              <div className="grow">
                <b>{dir.botName(id)}</b> {id === group.entryBot && <Pill tone="gray">entry</Pill>}
                <div className="t2">{s?.working ? s.label || "Working" : "Idle"}</div>
              </div>
            </div>
          );
        })}
      </InspectorSection>
    </>
  );
}

/** Right panel of a chat (312 px): the bot or the group behind `conversationId`. */
export function Inspector({ conversationId }: { conversationId: string }) {
  const dir = useDirectory();
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const conv = dir.conversations.find((c) => c.id === conversationId);
  const { bot, group } = conv ? conversationParts(dir, conv) : {};
  return (
    <div className="insp-in">
      {bot && <BotInspector bot={bot} status={status.find((s) => s.botId === bot.id)} />}
      {group && <GroupInspector group={group} status={status} />}
    </div>
  );
}

import type { BotDto, BotStatusDto, GroupDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  CircleStop,
  Info,
  LoaderCircle,
  SlidersHorizontal,
  UsersRound,
} from "lucide-react";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { formatCost } from "../../lib/format";
import { conversationParts } from "../chat/conversation-parts";
import { Avatar } from "../ui/avatar";
import { Pill } from "../ui/pill";
import { MemorySection, OpenTicketsSection, ScratchpadSection } from "./bot-inspector-sections";
import { PairFace } from "./chat-rows";
import { InspectorSection, Prop, QuickAction } from "./inspector-parts";
import { useAppNavigate } from "./use-app-navigate";
import { useStopRun } from "./use-stop-run";

/** Bot inspector: hero with Edit and Stop, what it is doing now, memory, settings, open tickets. */
function BotInspector({ bot, status }: { bot: BotDto; status?: BotStatusDto }) {
  const go = useAppNavigate();
  const stop = useStopRun();
  const working = status?.working ?? false;
  return (
    <>
      <div className="insp-hero">
        <Avatar src={bot.avatarUrl} name={bot.name} size={88} working={working} />
        <h2>{bot.name}</h2>
        <div className="r">{`${bot.title} · ${bot.model}`}</div>
        <div className="insp-actions">
          <QuickAction
            icon={<SlidersHorizontal strokeWidth={1.75} />}
            label="Edit"
            onClick={() => go(`/settings/bot/${bot.id}`)}
          />
          <QuickAction
            icon={<CircleStop strokeWidth={1.75} />}
            label="Stop"
            danger
            disabled={!working}
            onClick={() => void stop({ botId: bot.id })}
          />
        </div>
      </div>
      <InspectorSection title="Now" icon={<Activity strokeWidth={1.75} />} tone="blue">
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
      <MemorySection bot={bot} />
      <InspectorSection title="About" icon={<Info strokeWidth={1.75} />} tone="gray">
        <Prop label="Effort">{bot.effort ?? "Default"}</Prop>
        <Prop label="Spend today">{formatCost(status?.spendToday ?? 0)}</Prop>
        {bot.workspaces.map((w) => (
          <Prop key={w} label="Workspace">
            <span className="mono">{w}</span>
          </Prop>
        ))}
      </InspectorSection>
      <OpenTicketsSection botId={bot.id} />
      <ScratchpadSection botId={bot.id} />
    </>
  );
}

/** Group inspector: name, Edit, Stop all, and the members with the entry bot marked. */
function GroupInspector({ group, status }: { group: GroupDto; status: BotStatusDto[] }) {
  const go = useAppNavigate();
  const dir = useDirectory();
  const stop = useStopRun();
  const busy = (id: string) => status.some((s) => s.botId === id && s.working);
  return (
    <>
      <div className="insp-hero">
        {group.avatarUrl ? (
          <Avatar src={group.avatarUrl} name={group.name} size={88} />
        ) : (
          <PairFace
            faces={group.members.map((id) => ({ src: dir.bots.get(id)?.avatarUrl, name: "" }))}
            size={88}
          />
        )}
        <h2>{group.name}</h2>
        <div className="r">
          {group.members.length} members · {group.members.filter(busy).length} working
        </div>
        <div className="insp-actions">
          <QuickAction
            icon={<SlidersHorizontal strokeWidth={1.75} />}
            label="Edit"
            onClick={() => go(`/settings/group/${group.id}`)}
          />
          <QuickAction
            icon={<CircleStop strokeWidth={1.75} />}
            label="Stop all"
            danger
            disabled={!group.members.some(busy)}
            onClick={() => void stop({ conversationId: `group:${group.id}` })}
          />
        </div>
      </div>
      <InspectorSection title="Members" icon={<UsersRound strokeWidth={1.75} />} tone="teal">
        {group.members.map((id) => {
          const s = status.find((b) => b.botId === id);
          return (
            <div key={id} className="member">
              <Avatar
                src={dir.bots.get(id)?.avatarUrl}
                name={dir.botName(id)}
                size={32}
                working={s?.working ?? false}
              />
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

/** Right pane of a chat (chat info, 320 px): the bot or the group behind `conversationId`. */
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

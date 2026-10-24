import type { BotDto, BotStatusDto, ConversationDto, GroupDto } from "@friday/contracts";
import { CircleStop, PanelRight } from "lucide-react";
import { useDirectory } from "../../api/directory";
import { Toolbar } from "../shell/toolbar";
import { usePanels } from "../shell/use-responsive-panels";
import { useStopRun } from "../shell/use-stop-run";
import { Avatar } from "../ui/avatar";
import { IconButton } from "../ui/button";

export interface ChatToolbarProps {
  conversation: ConversationDto;
  bot?: BotDto;
  group?: GroupDto;
  status: BotStatusDto[];
}

/** Toolbar of a chat: face, name and live status on the left; Stop and the inspector toggle on the right. */
export function ChatToolbar({ conversation, bot, group, status }: ChatToolbarProps) {
  const dir = useDirectory();
  const panels = usePanels();
  const stop = useStopRun();
  const name = group?.name ?? bot?.name ?? conversation.title;

  let state: React.ReactNode = null;
  if (group) {
    const working = group.members.filter((id) => status.some((s) => s.botId === id && s.working));
    state = `${group.members.length} members · ${working.length} working`;
  } else if (bot) {
    const s = status.find((b) => b.botId === bot.id);
    state = s?.working ? (
      <span style={{ color: "var(--tint-text)" }}>{`${s.label || "Working"}…`}</span>
    ) : (
      "Idle"
    );
  }

  const stopLabel = group ? "Stop the group" : `Stop ${name}`;
  const face = group ? (
    <span className="stack">
      {group.members.map((id) => (
        <Avatar key={id} src={dir.bots.get(id)?.avatarUrl} name={dir.botName(id)} size={22} />
      ))}
    </span>
  ) : (
    <Avatar src={bot?.avatarUrl ?? conversation.avatarUrl} name={name} size={26} />
  );

  return (
    <Toolbar
      title={
        <>
          {face}
          <div>
            <h1>{name}</h1>
            <div className="st">{state}</div>
          </div>
        </>
      }
      actions={
        <>
          <IconButton
            label={stopLabel}
            onClick={() => void stop({ conversationId: conversation.id })}
          >
            <CircleStop size={16} strokeWidth={1.75} />
          </IconButton>
          <IconButton
            label="Toggle inspector (⌥⌘0)"
            on={panels.inspector.open}
            onClick={() => panels.toggle("inspector")}
          >
            <PanelRight size={16} strokeWidth={1.75} />
          </IconButton>
        </>
      }
    />
  );
}

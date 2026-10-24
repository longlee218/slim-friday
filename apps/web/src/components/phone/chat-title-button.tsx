import type { BotDto, ConversationDto, GroupDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, CircleStop } from "lucide-react";
import { useNavigate } from "react-router";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { useStopRun } from "../shell/use-stop-run";
import { Avatar, AvatarStack } from "../ui/avatar";
import { useBackLabel, usePhoneStack } from "./phone-shell";

export interface ChatTitleButtonProps {
  conversation: ConversationDto;
  bot?: BotDto;
  group?: GroupDto;
}

/**
 * The 58 px nav of a phone chat: back, a centre button (22 px face, name, status line) that
 * pushes the bot's or group's settings (their back then reads "Chat"), and Stop.
 */
export function ChatTitleButton({ conversation, bot, group }: ChatTitleButtonProps) {
  const navigate = useNavigate();
  const dir = useDirectory();
  const stop = useStopRun();
  const { back } = usePhoneStack();
  const backText = useBackLabel() ?? "Chats";
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const name = group?.name ?? bot?.name ?? conversation.title;

  let state = "Idle";
  if (group) {
    state = `${group.members.filter((id) => status.some((s) => s.botId === id && s.working)).length} working`;
  } else if (bot) {
    const s = status.find((b) => b.botId === bot.id);
    if (s?.working) state = s.label || "Working";
  }
  const face = group ? (
    <AvatarStack
      items={group.members.slice(0, 3).map((id) => ({
        src: dir.bots.get(id)?.avatarUrl,
        name: dir.botName(id),
      }))}
      size={22}
    />
  ) : (
    <Avatar src={bot?.avatarUrl ?? conversation.avatarUrl} name={name} size={22} />
  );
  const details = bot ? `/settings/bot/${bot.id}` : group ? `/settings/group/${group.id}` : null;

  return (
    <div className="ios-nav chatnav">
      <button type="button" className="nb back" onClick={back}>
        <ChevronLeft strokeWidth={1.75} />
        {backText}
      </button>
      <div className="chat-nav-mid">
        <button
          type="button"
          className="cnm"
          aria-label={`${name} details`}
          disabled={!details}
          onClick={() => details && void navigate(details)}
        >
          {face}
          <b>
            {name}
            <ChevronRight size={12} strokeWidth={1.75} />
          </b>
          <span className="st">{state}</span>
        </button>
      </div>
      <button
        type="button"
        className="nb"
        aria-label="Stop"
        onClick={() => void stop({ conversationId: conversation.id })}
      >
        <CircleStop strokeWidth={1.75} />
      </button>
    </div>
  );
}

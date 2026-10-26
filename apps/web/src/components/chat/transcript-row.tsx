import type { MessageDto, MessageReaction } from "@friday/contracts";
import type { LiveRun } from "../../events/client-keys";
import { Avatar } from "../ui/avatar";
import { ApprovalCard } from "./approval-card";
import { ApprovalRow } from "./approval-row";
import { BotMessage } from "./bot-message";
import type { RunPlace } from "./bubble-layout";
import { OwnerBubble } from "./owner-bubble";
import { QuestionCard } from "./question-card";
import { RelayCard } from "./relay-card";
import type { RouteInfo } from "./route-info";
import { RunBlock } from "./run-block";
import { DayLine, SystemLine } from "./system-line";
import type { TranscriptItem } from "./transcript-items";
import { useBotFace } from "./use-bot-face";

/** A bot's run in progress: the working face at its left, the name above it when it opens a run in a group. */
function LiveRunRow({ run, group, place }: { run: LiveRun; group: boolean; place?: RunPlace }) {
  const bot = useBotFace(run.botId);
  const head = place?.head ?? true;
  return (
    <div className={head ? "msg bot first last" : "msg bot last"}>
      <div className="face">
        <Avatar src={bot.src} name={bot.name} size={30} working />
      </div>
      <div className="body">
        {group && head && (
          <div className="who">
            <b>{bot.name}</b>
          </div>
        )}
        <RunBlock run={run} />
      </div>
    </div>
  );
}

export interface TranscriptRowProps {
  item: TranscriptItem;
  phone: boolean;
  /** Bot ids of the conversation (the bot, or the group's members). */
  members: string[];
  /** A group chat: bot names show above the first message of each run. */
  group: boolean;
  /** Route of a still-unconfirmed owner message, by temp id. */
  routeOf(messageId: number): RouteInfo | undefined;
  /** True for a bot message that arrived over the stream after the view opened. */
  isFresh(m: MessageDto): boolean;
  onReply(m: MessageDto): void;
  onReact(m: MessageDto, emoji: MessageReaction): void;
  onRetry(tempId: number): void;
}

/** One transcript row: picks the component for a day line, message, card or live run. */
export function TranscriptRow(p: TranscriptRowProps) {
  const { item } = p;
  switch (item.kind) {
    case "day":
      return <DayLine at={item.at} />;
    case "approval":
      return p.phone ? (
        <ApprovalRow card={item.card} receipt={item.receipt} />
      ) : (
        <ApprovalCard card={item.card} receipt={item.receipt} />
      );
    case "question":
      return <QuestionCard card={item.card} receipt={item.receipt} />;
    case "run":
      return <LiveRunRow run={item.run} group={p.group} place={item.place} />;
    case "message": {
      const m = item.message;
      if (m.author.kind === "system") return <SystemLine message={m} />;
      if (m.kind === "relay") return <RelayCard message={m} />;
      if (m.author.kind === "user") {
        return (
          <OwnerBubble
            message={m}
            members={p.members}
            route={p.routeOf(m.id)}
            pending={item.pending}
            {...(item.place && { place: item.place })}
            onRetry={() => p.onRetry(m.id)}
          />
        );
      }
      return (
        <BotMessage
          message={m}
          phone={p.phone}
          onReply={p.onReply}
          onReact={p.onReact}
          fresh={p.isFresh(m)}
          group={p.group}
          {...(item.place && { place: item.place })}
          {...(item.reactions && { reactions: item.reactions })}
        />
      );
    }
  }
}

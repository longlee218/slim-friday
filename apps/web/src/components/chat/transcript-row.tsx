import type { MessageDto } from "@friday/contracts";
import type { LiveRun } from "../../events/client-keys";
import { Avatar } from "../ui/avatar";
import { ApprovalCard } from "./approval-card";
import { ApprovalRow } from "./approval-row";
import { BotMessage } from "./bot-message";
import { OwnerBubble } from "./owner-bubble";
import { QuestionCard } from "./question-card";
import { RelayCard } from "./relay-card";
import type { RouteInfo } from "./route-info";
import { RunBlock } from "./run-block";
import { DayLine, SystemLine } from "./system-line";
import type { TranscriptItem } from "./transcript-items";
import { useBotFace } from "./use-bot-face";

/** A bot's run in progress: its face and name above the run block. */
function LiveRunRow({ run }: { run: LiveRun }) {
  const bot = useBotFace(run.botId);
  return (
    <div className="msg">
      <Avatar src={bot.src} name={bot.name} size={30} />
      <div className="body">
        <div className="who">
          <b>{bot.name}</b>
        </div>
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
  /** Route of a still-unconfirmed owner message, by temp id. */
  routeOf(messageId: number): RouteInfo | undefined;
  /** True for a bot message that arrived over the stream after the view opened. */
  isFresh(m: MessageDto): boolean;
  onReply(m: MessageDto): void;
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
      return <LiveRunRow run={item.run} />;
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
            onRetry={() => p.onRetry(m.id)}
          />
        );
      }
      return <BotMessage message={m} phone={p.phone} onReply={p.onReply} fresh={p.isFresh(m)} />;
    }
  }
}

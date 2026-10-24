import type { MessageDto } from "@friday/contracts";
import { ArrowRight, Check, CornerDownLeft } from "lucide-react";
import { Avatar } from "../ui/avatar";
import { Pill } from "../ui/pill";
import { TicketText } from "./ticket-text";
import { useBotFace } from "./use-bot-face";

const INTENT = {
  request: { tone: "blue", verb: "asks" },
  handoff: { tone: "violet", verb: "hands off to" },
  result: { tone: "green", verb: "replies to" },
} as const;

/** One bot talking to another: two faces, "<From> asks <To>", the text and its state. */
export function RelayCard({ message }: { message: MessageDto }) {
  const relay = message.relay;
  const from = useBotFace(relay?.fromBotId);
  const to = useBotFace(relay?.toBotId);
  if (!relay) return null;
  const { tone, verb } = INTENT[relay.intent];
  const StateIcon = relay.intent === "result" ? CornerDownLeft : Check;
  return (
    <div className="relay">
      <span className="pair">
        <Avatar src={from.src} name={from.name} size={20} />
        <ArrowRight strokeWidth={1.75} />
        <Avatar src={to.src} name={to.name} size={20} />
      </span>
      <div>
        <div className="rl1">
          <b>{from.name}</b>
          <span style={{ color: "var(--label-2)" }}>{verb}</span>
          <b>{to.name}</b>
          <Pill tone={tone}>{relay.intent}</Pill>
        </div>
        <div className="rl2">
          <TicketText text={message.text} />
        </div>
        {relay.state && (
          <div className="rl3">
            <StateIcon strokeWidth={1.75} />
            {relay.state}
          </div>
        )}
      </div>
    </div>
  );
}

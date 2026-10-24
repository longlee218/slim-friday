import type { ChannelTarget } from "./discord-port";

/** Ids look like the config file stems (`^[a-z][a-z0-9-]{0,31}$`). */
const TOPIC = /^friday:(bot|group):([a-z][a-z0-9-]{0,31})$/;

/** The channel topic that records which bot or group a channel belongs to. */
export function topicFor(t: ChannelTarget): string {
  return t.kind === "bot" ? `friday:bot:${t.botId}` : `friday:group:${t.groupId}`;
}

/** The target a topic names; anything that is not exactly a Friday topic is `undefined`. */
export function parseTopic(topic: string | null | undefined): ChannelTarget | undefined {
  const m = topic ? TOPIC.exec(topic) : null;
  if (!m?.[2]) return undefined;
  return m[1] === "bot" ? { kind: "bot", botId: m[2] } : { kind: "group", groupId: m[2] };
}

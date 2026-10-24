import type { BotDto, ConversationDto, GroupDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { orpc } from "./client";

/** Everything the shell needs to name things: bots, groups and the conversation list. */
export interface Directory {
  bots: Map<string, BotDto>;
  groups: Map<string, GroupDto>;
  conversations: ConversationDto[];
  /** A bot's display name; the id itself while the bot list is not loaded or the bot is gone. */
  botName(id: string): string;
}

/** Reads the three lists from the query cache (the event stream keeps them fresh). */
export function useDirectory(): Directory {
  const bots = useQuery(orpc.config.bots.list.queryOptions()).data;
  const groups = useQuery(orpc.config.groups.list.queryOptions()).data;
  const conversations = useQuery(orpc.conversations.list.queryOptions()).data;
  return useMemo(() => {
    const botMap = new Map((bots ?? []).map((b) => [b.id, b]));
    return {
      bots: botMap,
      groups: new Map((groups ?? []).map((g) => [g.id, g])),
      conversations: conversations ?? [],
      botName: (id: string) => botMap.get(id)?.name ?? id,
    };
  }, [bots, groups, conversations]);
}

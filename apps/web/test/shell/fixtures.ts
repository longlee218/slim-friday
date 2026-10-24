import type {
  ApprovalCardDto,
  BotDto,
  BotStatusDto,
  ConversationDto,
  GroupDto,
} from "@friday/contracts";
import { QueryClient } from "@tanstack/react-query";
import { orpc } from "../../src/api/client";

export const bot = (id: string, name: string): BotDto => ({
  id,
  name,
  title: "",
  instructions: "",
  model: "m",
  tools: [],
  skills: [],
  subagents: [],
  workspaces: [],
});

export const group = (id: string, name: string, members: string[]): GroupDto => ({
  id,
  name,
  members,
  entryBot: members[0] ?? "",
  workspaces: [],
  instructions: "",
});

export const conv = (id: string, unread: number): ConversationDto => ({
  id,
  kind: id.startsWith("bot:") ? "direct" : "group",
  title: id,
  unread,
});

export const status = (
  botId: string,
  name: string,
  working: boolean,
  label?: string,
  spendToday = 0,
): BotStatusDto => ({ botId, name, working, label, tasks: [], spendToday });

export const approval = (
  cardId: string,
  botId: string,
  extra: Partial<ApprovalCardDto> = {},
): ApprovalCardDto => ({
  cardId,
  conversationId: `bot:${botId}`,
  botId,
  botName: botId === "dev" ? "Dev" : botId,
  tool: "Bash",
  summary: "run ls",
  scope: { command: "git push" },
  offerAlways: true,
  ...extra,
});

/** A client that never fetches: tests seed the cache and read it as fresh. */
export function seededClient(seed: {
  bots?: BotDto[];
  groups?: GroupDto[];
  conversations?: ConversationDto[];
  status?: BotStatusDto[];
  approvals?: ApprovalCardDto[];
}): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(orpc.config.bots.list.queryKey(), seed.bots ?? []);
  qc.setQueryData(orpc.config.groups.list.queryKey(), seed.groups ?? []);
  qc.setQueryData(orpc.conversations.list.queryKey(), seed.conversations ?? []);
  qc.setQueryData(orpc.control.status.queryKey(), seed.status ?? []);
  qc.setQueryData(orpc.approvals.pending.queryKey(), seed.approvals ?? []);
  qc.setQueryData(orpc.questions.pending.queryKey(), []);
  return qc;
}

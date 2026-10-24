import type { ApprovalCardDto, FridayEvent, MessageDto, RunStepDto } from "@friday/contracts";

/** A bot-authored text message. */
export const botMsg = (botId: string, id: number, conversationId = `bot:${botId}`): MessageDto => ({
  id,
  conversationId,
  author: { kind: "bot", botId },
  kind: "text",
  text: `m${id}`,
  at: id,
  files: [],
});

/** A message event from a bot in a conversation. */
export const msgEvt = (conversationId: string): FridayEvent => ({
  type: "message",
  conversationId,
  message: botMsg(conversationId.replace("bot:", ""), 9, conversationId),
});

/** A run step. */
export const step = (
  kind: RunStepDto["kind"],
  state: RunStepDto["state"],
  id = "s1",
): RunStepDto => ({ id, kind, label: kind, state, startedAt: 500 });

/** An approval card. */
export const approvalCard = (cardId = "c1"): ApprovalCardDto => ({
  cardId,
  conversationId: "bot:dev",
  botId: "dev",
  botName: "Dev",
  tool: "Bash",
  summary: "run ls",
  scope: {},
  offerAlways: true,
  input: "{}",
  inputCut: false,
});

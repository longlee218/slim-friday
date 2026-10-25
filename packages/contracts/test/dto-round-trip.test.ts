import { expect, test } from "bun:test";
import {
  ConversationIdSchema,
  FridayEventSchema,
  McpServerDtoSchema,
  McpServerSpecDtoSchema,
  MessageDtoSchema,
  RuleDtoSchema,
  TicketRefSchema,
} from "../src";

/** Compare a parsed value with its input without typing the input as the output. */
const same = (parsed: unknown, input: unknown) => expect(parsed).toEqual(input);

const minimalMessage = {
  id: 1,
  conversationId: "bot:ana",
  author: { kind: "user" },
  kind: "text",
  text: "hi",
  at: 1,
};

test("a full message round-trips", () => {
  const m = {
    id: 7,
    conversationId: "group:dev",
    author: { kind: "bot", botId: "ana" },
    kind: "text",
    text: "hi",
    at: 1,
    replyTo: { messageId: 3, botId: "ana", excerpt: "q" },
    files: [],
    run: [
      {
        id: "t1",
        kind: "tool",
        label: "Read",
        target: "/a",
        state: "done",
        startedAt: 1,
        endedAt: 2,
      },
    ],
  };
  same(MessageDtoSchema.parse(m), m);
});

test("files default to []", () => {
  expect(MessageDtoSchema.parse({ ...minimalMessage, files: undefined }).files).toEqual([]);
  expect(MessageDtoSchema.parse(minimalMessage).files).toEqual([]);
});

test("bad ids are refused", () => {
  for (const id of ["dev", "bot:", "bot:Ana", "bot:../x", "channel:1"]) {
    expect(ConversationIdSchema.safeParse(id).success).toBe(false);
  }
  expect(ConversationIdSchema.parse("bot:ana")).toBe("bot:ana");
});

const message = MessageDtoSchema.parse(minimalMessage);
const card = {
  cardId: "c1",
  conversationId: "bot:ana",
  botId: "ana",
  botName: "Ana",
  tool: "Bash",
  summary: "ls",
  scope: { cmd: "ls" },
  offerAlways: true,
  input: "{}",
  inputCut: false,
};
const qcard = {
  cardId: "q1",
  conversationId: "bot:ana",
  botId: "ana",
  botName: "Ana",
  question: "ok?",
  kind: "confirm",
  options: [{ value: "y", label: "Yes" }],
  allowText: false,
};
const ticket = {
  id: "t",
  ref: "FRI-1",
  number: 1,
  title: "x",
  status: "todo",
  priority: "normal",
  createdBy: { kind: "user" },
  createdAt: 1,
  updatedAt: 1,
  commentCount: 0,
};
const status = { botId: "ana", name: "Ana", working: false, tasks: [], spendToday: 0 };
const events = [
  { type: "message", conversationId: "bot:ana", message },
  { type: "activity", conversationId: "bot:ana", botId: "ana", kind: "typing" },
  { type: "approval.opened", card },
  { type: "approval.closed", cardId: "c1", answer: "once" },
  { type: "question.opened", card: qcard },
  { type: "question.closed", cardId: "q1", answer: { choices: ["y"] } },
  {
    type: "run",
    conversationId: "bot:ana",
    botId: "ana",
    step: { id: "s", kind: "thinking", label: "Thinking", state: "running", startedAt: 1 },
  },
  { type: "unread", conversationId: "bot:ana", unread: 2 },
  { type: "status", bots: [status] },
  { type: "ticket", ticket },
  { type: "config.changed" },
  { type: "mcp.auth", server: "db", status: "needs_login" },
  { type: "resync" },
];

test("every FridayEvent type parses and an unknown type is refused", () => {
  expect(events).toHaveLength(13);
  for (const e of events) same(FridayEventSchema.parse(e), e);
  expect(FridayEventSchema.safeParse({ type: "nope" }).success).toBe(false);
});

test("question.closed accepts a null answer (timed out)", () => {
  const e = { type: "question.closed", cardId: "q1", answer: null };
  same(FridayEventSchema.parse(e), e);
});

test("RuleDto refuses 501 chars, empty text and a line break", () => {
  expect(RuleDtoSchema.safeParse({ text: "a".repeat(501), on: true }).success).toBe(false);
  expect(RuleDtoSchema.safeParse({ text: "  ", on: true }).success).toBe(false);
  expect(RuleDtoSchema.safeParse({ text: "a\nb", on: true }).success).toBe(false);
  expect(RuleDtoSchema.safeParse({ text: "a".repeat(500), on: false }).success).toBe(true);
});

test("McpServerSpecDto refuses an unknown type and an extra key", () => {
  expect(McpServerSpecDtoSchema.safeParse({ type: "sse", url: "x" }).success).toBe(false);
  expect(McpServerSpecDtoSchema.safeParse({ type: "http", url: "x", extra: 1 }).success).toBe(
    false,
  );
  const ok = { type: "stdio", command: "npx", args: ["a"] };
  same(McpServerSpecDtoSchema.parse(ok), ok);
});

test("TicketRefSchema accepts FRI-3 and fri-3, refuses FRI-0 and BUG-1", () => {
  expect(TicketRefSchema.safeParse("FRI-3").success).toBe(true);
  expect(TicketRefSchema.safeParse("fri-3").success).toBe(true);
  expect(TicketRefSchema.safeParse("FRI-0").success).toBe(false);
  expect(TicketRefSchema.safeParse("BUG-1").success).toBe(false);
});

test("McpServerDto holds the spec, name, shipped and usedBy", () => {
  const s = { name: "gh", type: "http", url: "https://x", shipped: false, usedBy: ["ana"] };
  same(McpServerDtoSchema.parse(s), s);
  expect(McpServerDtoSchema.safeParse({ ...s, extra: 1 }).success).toBe(false);
});

test("approval.closed accepts a null answer (withdrawn)", () => {
  const e = { type: "approval.closed", cardId: "c1", answer: null };
  same(FridayEventSchema.parse(e), e);
});

test("spec with oauth parses; oauth + Authorization header refused", () => {
  const ok = { type: "http", url: "https://x.example/mcp", oauth: { scopes: ["read"] } };
  same(McpServerSpecDtoSchema.parse(ok), ok);
  const bare = { type: "http", url: "https://x.example/mcp", oauth: {} };
  same(McpServerSpecDtoSchema.parse(bare), bare);
  const withAuth = { ...ok, headers: { authorization: "$" + "{T}" } };
  expect(McpServerSpecDtoSchema.safeParse(withAuth).success).toBe(false);
  expect(McpServerSpecDtoSchema.safeParse({ ...ok, url: "http://x.example/mcp" }).success).toBe(
    false,
  );
  expect(McpServerSpecDtoSchema.safeParse({ ...ok, oauth: { extra: 1 } }).success).toBe(false);
});

test("McpServerDto carries the oauth block and the sign-in status", () => {
  const s = {
    name: "db",
    type: "http",
    url: "https://x.example/mcp",
    oauth: {},
    shipped: false,
    usedBy: [],
    auth: { status: "connected", lastRefreshAt: 5 },
  };
  same(McpServerDtoSchema.parse(s), s);
  const bad = { ...s, auth: { status: "nope" } };
  expect(McpServerDtoSchema.safeParse(bad).success).toBe(false);
});

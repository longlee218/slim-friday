import { clip } from "./redact";

/** Max chars of a console line's message part. */
const LINE_MAX = 200;

/**
 * Fields pino-pretty never prints (the file keeps them). Minimal on purpose: `ignore` is global, so
 * anything hidden here is hidden on every event. Task context and tool.* detail are instead moved
 * into the message by `consoleMessage`, which deletes them from the record it is given.
 */
export const CONSOLE_IGNORE = ["pid", "hostname", "module", "event", "toolUseId", "input", "runId"];

/** Task context keys: shown as the `· 8f3a1c2e ws/repo <role>` suffix, never as a JSON tail. */
const CONTEXT_KEYS = ["traceId", "threadId", "channelId", "taskId", "workspace", "repo", "mode"];
/** Detail keys of tool.* events: folded into the message body. */
const TOOL_KEYS = [
  "tool",
  "target",
  "ok",
  "durationMs",
  "chars",
  "approx",
  "lines",
  "files",
].concat(["truncated", "err", "decision", "reason", "agentId", "agentType"]);

/** Events that always show where they happened (thread/channel). */
const SHOW_THREAD = new Set(["task.started", "message.received"]);
/** pino level numbers from warn up. */
const WARN_LEVEL = 40;

/** Size in KB with one decimal (below 1 KB: bytes); `~` when the size is approximate. */
const size = (n: number, approx: boolean) =>
  `${approx ? "~" : ""}${n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`}`;

type Log = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : String(v));

/** Compact body of a tool.* line: `Read src/a.ts:1-9 ok 1ms 90 lines 3.7KB`. */
function toolBody(l: Log): string {
  // A subagent's call shows its type (`Read src/a.ts @<type>`); the main agent's has none.
  const head = [s(l.tool), s(l.target), l.agentType && `@${s(l.agentType)}`].filter(Boolean);
  if (l.event === "tool.start") return head.join(" ");
  if (l.event === "tool.denied") return [...head, "DENIED", s(l.reason)].filter(Boolean).join(" ");
  const parts = [...head, l.ok === false ? "FAILED" : "ok", `${s(l.durationMs)}ms`];
  if (typeof l.lines === "number") parts.push(`${l.lines} lines`);
  if (typeof l.files === "number") parts.push(`${l.files} files`);
  if (typeof l.chars === "number") parts.push(size(l.chars, l.approx === true));
  if (l.truncated) parts.push("truncated");
  if (l.decision) parts.push(`${s(l.decision)}:${s(l.reason)}`);
  if (l.err) parts.push(`err="${s(l.err)}"`);
  return parts.join(" ");
}

/** Detail keys of an `llm.turn` line from the stream (see turn-usage.ts): folded into the message body. */
const TURN_KEYS = [
  "turn",
  "in",
  "cacheRead",
  "cacheCreate",
  "outApprox",
  "ctxTotal",
  "model",
].concat(["sub", "agentId"]);

/** Token count as `27.3k` (below 1000: as is). */
const kilo = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`);

/** Compact body of a stream `llm.turn`: `llm.turn #3 ctx 27.3k (cache 99%) out~16 sub:a1b2c3 model`. */
function turnBody(l: Log): string {
  const inn = Number(l.in);
  const cache = inn > 0 ? Math.round((Number(l.cacheRead) / inn) * 100) : 0;
  const who = l.sub ? ` sub${l.agentId ? `:${s(l.agentId).slice(0, 6)}` : ""}` : "";
  return `llm.turn #${s(l.turn)} ctx ${kilo(inn)} (cache ${cache}%) out~${s(l.outApprox)}${who}${l.model ? ` ${s(l.model)}` : ""}`;
}

/**
 * pino-pretty `messageFormat`: one short line per record. tool.* events render compactly (their detail
 * keys are deleted from the record so pretty prints no JSON tail); other events keep their message and
 * their own fields. A suffix names the task. Thread/channel show on task.started, message.*, and
 * warn/error lines. Without run context (no `mode`) a taskId is an explicit field and stays in full.
 */
export function consoleMessage(l: Log): string {
  const event = s(l.event);
  const isTool = event.startsWith("tool.");
  // pino-pretty prints an `err` key itself only when it is an Error object; our `err` is a string.
  const errPart = !isTool && l.err !== undefined ? ` err=${s(l.err)}` : "";
  // Only the stream's llm.turn has `turn` (attachment/intent llm.turn lines keep their own fields).
  const isTurn = event === "llm.turn" && typeof l.turn === "number";
  const body = isTool ? `${event} ${toolBody(l)}` : isTurn ? turnBody(l) : s(l.msg) + errPart;
  const showThread =
    SHOW_THREAD.has(event) || event.startsWith("message.") || Number(l.level) >= WARN_LEVEL;
  const inContext = l.mode !== undefined;
  const parts = [
    showThread && l.threadId && `thread=${s(l.threadId)}`,
    showThread && l.channelId && `channel=${s(l.channelId)}`,
    l.taskId && (inContext ? s(l.taskId).slice(0, 8) : `taskId=${s(l.taskId)}`),
    l.workspace
      ? `${s(l.workspace)}${l.repo ? `/${s(l.repo)}` : ""}`
      : l.repo && `repo=${s(l.repo)}`,
    l.mode,
  ];
  const suffix = parts.filter(Boolean).join(" ");
  // Hide what is now in the message (pretty prints every remaining key as a JSON tail).
  for (const k of CONTEXT_KEYS) delete l[k];
  if (isTool) for (const k of TOOL_KEYS) delete l[k];
  else if (isTurn) for (const k of TURN_KEYS) delete l[k];
  else if (errPart) delete l.err;
  return clip(body, LINE_MAX) + (suffix ? `  · ${suffix}` : "");
}

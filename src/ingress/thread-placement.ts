import type { Message } from "discord.js";
import { localDay, localHhmm } from "../memory/memory-clock";
import { logger } from "../observability/logger";
import { errText } from "../observability/redact";
import type { Route } from "./discord-message-rules";

/** Prefix of a placeholder thread name: "the agent has not named this thread yet". */
const PLACEHOLDER_PREFIX = "⏳";

/** Neutral thread name `⏳ MM-DD HH:MM` (local time); the agent renames it once it knows the topic. */
export function placeholderName(now: Date = new Date()): string {
  return `${PLACEHOLDER_PREFIX} ${localDay(now).slice(5)} ${localHhmm(now)}`;
}

/** Where the handler persists threads and learns which channels are mapped to a space (built in index.ts). */
export interface ThreadsPort {
  /** True when the thread was adopted (owner-made, answered without a mention). */
  isAdopted(threadId: string): boolean;
  /** Persist an adoption (row `origin='adopted'`). */
  adopt(threadId: string, channelId: string): void;
  /** Persist a thread the bot opened, with its placeholder name. */
  recordBotThread(threadId: string, channelId: string, placeholder: string): void;
  /** Workspace and mode of a parent channel mapped to a space; undefined when unmapped. Used for adoption. */
  channelInfo(channelId: string): { workspace: string; mode: "task" | "chat" } | undefined;
}

const log = logger.child({ module: "thread-placement" });

/**
 * True only for a REAL owner message that @mentions the bot (`<@id>` in the text). A slash command is a
 * synthetic message whose `mentions.has` is always true, so it never adopts a thread.
 */
function mayAdopt(
  msg: { author: { id: string }; content: string },
  ownerId: string,
  botId: string,
): boolean {
  return msg.author.id === ownerId && new RegExp(`<@!?${botId}>`).test(msg.content);
}

/**
 * The thread facts `routeMessage` needs, read from the channel and the port. Never throws: a store or
 * workspace-load error is logged and the thread counts as not adopted / not adoptable. Only the owner's
 * `msg` (a real @mention for adoption, see `mayAdopt`) triggers the costly `channelInfo` lookups, so strangers never load the workspaces.
 * `chatChannel`: the channel itself is mapped with `mode: chat` (the owner talks in it inline, no thread).
 */
export function threadFacts(
  ch: { id: string; isThread(): boolean; ownerId?: string | null; parentId?: string | null },
  botId: string,
  ops: ReadonlySet<string>,
  threads?: ThreadsPort,
  msg?: { author: { id: string }; content: string },
  ownerId?: string,
  inGuild = true,
): {
  inBotThread: boolean;
  adoptedThread: boolean;
  adoptableThread: boolean;
  chatChannel: boolean;
} {
  const inThread = ch.isThread();
  const isOwner = !!msg && msg.author.id === ownerId;
  const canAdopt = !!msg && !!ownerId && mayAdopt(msg, ownerId, botId);
  const inBotThread = inThread && ch.ownerId === botId;
  let adoptedThread = false;
  let adoptableThread = false;
  let chatChannel = false;
  try {
    // Only the owner's message looks the channel up (strangers never load the workspaces); ops channels never chat.
    chatChannel =
      isOwner &&
      inGuild &&
      !inThread &&
      !ops.has(ch.id) &&
      threads?.channelInfo(ch.id)?.mode === "chat";
    adoptedThread = inThread && !inBotThread && !!threads?.isAdopted(ch.id); // one indexed query
    adoptableThread =
      canAdopt &&
      inThread &&
      !inBotThread &&
      !adoptedThread &&
      !!ch.parentId &&
      !ops.has(ch.parentId) &&
      !!threads?.channelInfo(ch.parentId);
  } catch (err) {
    log.error({ err: errText(err) }, "thread facts failed");
    adoptedThread = false;
    adoptableThread = false;
    chatChannel = false;
  }
  return { inBotThread, adoptedThread, adoptableThread, chatChannel };
}

/** Persist an `adopt` route and return it as the `thread` turn it becomes. A store failure is logged, the turn goes on. */
export function adoptRoute(
  route: Extract<Route, { kind: "adopt" }>,
  threadId: string,
  parentId: string,
  threads?: ThreadsPort,
): Extract<Route, { kind: "thread" }> {
  try {
    threads?.adopt(threadId, parentId);
    log.info({ threadId, channelId: parentId }, "thread adopted");
  } catch (err) {
    log.error({ err: errText(err) }, "thread adoption failed");
  }
  return { kind: "thread", prompt: route.prompt };
}

/** Open a thread from the message with the placeholder name and record it. Recording errors never block the turn. */
export async function openThread(
  msg: Pick<Message, "startThread">,
  channelId: string,
  threads?: ThreadsPort,
): ReturnType<Message["startThread"]> {
  const name = placeholderName();
  const thread = await msg.startThread({ name });
  try {
    threads?.recordBotThread(thread.id, channelId, name);
  } catch (err) {
    log.error({ err: errText(err) }, "thread record failed");
  }
  return thread;
}

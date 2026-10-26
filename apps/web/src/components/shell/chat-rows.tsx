import type { ConversationDto, MessageDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import type { MouseEvent } from "react";
import { orpc } from "../../api/client";
import { type Directory, useDirectory } from "../../api/directory";
import { formatClock } from "../../lib/format";
import { conversationParts } from "../chat/conversation-parts";
import { Avatar } from "../ui/avatar";
import { Pill } from "../ui/pill";
import { Trailing, type TrailingMark, trailingMark } from "./sidebar-row";

/** Markdown code marks dropped and whitespace folded, so a preview reads as one line. */
const oneLine = (text: string) =>
  text
    .replace(/```[\w-]*/g, " ")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The one-line meaning of a last message: `You: …`, `A → B: …` for a relay, else the text. */
export function previewOf(m: MessageDto | undefined, dir: Directory): string {
  if (!m) return "No messages yet";
  const text = oneLine(m.text) || m.files[0]?.name || "";
  if (m.kind === "relay" && m.relay) {
    return `${dir.botName(m.relay.fromBotId)} → ${dir.botName(m.relay.toBotId)}: ${text}`;
  }
  return m.author.kind === "user" ? `You: ${text}` : text;
}

/** One row of the chat list: a bot or group chat, with or without messages yet. */
export interface ChatRowData {
  id: string;
  kind: "bot" | "group";
  name: string;
  /** Own face; for a group without one, `faces` holds its first two members. */
  src?: string;
  faces?: { src?: string; name: string }[];
  /** A bot working now (or, for a group, how many of its members). */
  working: number;
  workLabel?: string;
  last?: MessageDto;
  mark: TrailingMark;
  approval: boolean;
  question: boolean;
  unread: boolean;
}

/** The bot or group behind a chat row (`bot:<id>` / `group:<id>`). */
export const targetOf = (r: ChatRowData): { kind: "bot" | "group"; id: string } => ({
  kind: r.kind,
  id: r.id.slice(r.id.indexOf(":") + 1),
});

/** True when the row may offer Delete: any group, or a bot the engine marks deletable. */
export const canDelete = (r: ChatRowData, dir: Directory): boolean =>
  r.kind === "group"
    ? dir.groups.has(targetOf(r).id)
    : dir.bots.get(targetOf(r).id)?.deletable === true;

/** Newest message first; chats without one keep their order at the end. */
const byRecent = (a: ChatRowData, b: ChatRowData) => (b.last?.at ?? 0) - (a.last?.at ?? 0);

/** Every bot and group as a chat row (plus any other conversation), newest first. */
export function useChatRows(): ChatRowData[] {
  const dir = useDirectory();
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];
  const questions = useQuery(orpc.questions.pending.queryOptions()).data ?? [];
  const byId = new Map<string, ConversationDto>(dir.conversations.map((c) => [c.id, c]));
  const ids = [
    ...[...dir.bots.keys()].map((id) => `bot:${id}`),
    ...[...dir.groups.keys()].map((id) => `group:${id}`),
    ...dir.conversations.map((c) => c.id),
  ];
  return [...new Set(ids)]
    .map((id): ChatRowData | undefined => {
      const c = byId.get(id);
      const { bot, group } = c
        ? conversationParts(dir, c)
        : {
            bot: id.startsWith("bot:") ? dir.bots.get(id.slice(4)) : undefined,
            group: id.startsWith("group:") ? dir.groups.get(id.slice(6)) : undefined,
          };
      if (!bot && !group && !c) return undefined;
      const live = bot ? status.filter((s) => s.botId === bot.id && s.working) : [];
      const busy = group
        ? group.members.filter((m) => status.some((s) => s.botId === m && s.working))
        : [];
      const working = bot ? live.length : busy.length;
      const pending = approvals.filter((a) => a.conversationId === id).length;
      const unread = c?.unread ?? 0;
      return {
        id,
        kind: group ? "group" : "bot",
        name: group?.name ?? bot?.name ?? c?.title ?? id,
        src: group ? group.avatarUrl : (bot?.avatarUrl ?? c?.avatarUrl),
        faces:
          group && !group.avatarUrl
            ? group.members.slice(0, 2).map((m) => ({ src: dir.bots.get(m)?.avatarUrl, name: "" }))
            : undefined,
        working,
        workLabel: group ? `${working} working` : live[0]?.label || "Working",
        last: c?.lastMessage,
        // A group shows "N working" at the edge; a bot says what it does on line 2.
        mark: trailingMark({ approvals: pending, unread, working: Boolean(group) && working > 0 }),
        approval: pending > 0,
        question: questions.some((q) => q.conversationId === id),
        unread: unread > 0 || pending > 0,
      };
    })
    .filter((r): r is ChatRowData => r !== undefined)
    .sort(byRecent);
}

/** Two member faces overlapping on a diagonal (Messenger's face for a group without its own). */
export function PairFace({
  faces,
  size,
}: {
  faces: { src?: string; name: string }[];
  size: number;
}) {
  return (
    <span className="gav" style={{ width: size, height: size }}>
      {faces.slice(0, 2).map((f, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two static faces
        <Avatar key={i} src={f.src} name={f.name} size={Math.round(size * 0.66)} />
      ))}
    </span>
  );
}

/** A chat's face: its own avatar, or two member faces overlapping (Messenger's group face). */
function ChatFace({ row, size }: { row: ChatRowData; size: number }) {
  if (row.faces) return <PairFace faces={row.faces} size={size} />;
  return (
    <Avatar
      src={row.src}
      name={row.name}
      size={size}
      working={row.kind === "bot" && row.working > 0}
    />
  );
}

export interface ChatRowProps {
  row: ChatRowData;
  /** The open chat: draws the shared `.sel` element (view transition between rows). */
  on?: boolean;
  /** Face diameter (desktop 44, phone 56). */
  size: number;
  onOpen(href: string): void;
}

/** Messenger row: face, name and time, then the last line (or live work) and the count badge. */
export function ChatRow({ row, on, size, onOpen }: ChatRowProps) {
  const dir = useDirectory();
  const href = `/c/${row.id}`;
  const open = (e: MouseEvent) => {
    // Let the browser handle new-tab clicks; everything else stays in the SPA.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onOpen(href);
  };
  return (
    <a
      className={`crow${on ? " on" : ""}${row.unread ? " unread" : ""}`}
      href={href}
      aria-current={on ? "page" : undefined}
      onClick={open}
    >
      {on && <span className="sel" />}
      <ChatFace row={row} size={size} />
      <div className="grow">
        <div className="l1">
          <b>{row.name}</b>
          <time>{row.last ? formatClock(row.last.at, Date.now()) : ""}</time>
        </div>
        <div className="l2">
          <span className="txt">
            {row.approval ? (
              <Pill tone="amber">Approval</Pill>
            ) : (
              row.question && <Pill tone="blue">Question</Pill>
            )}{" "}
            {row.kind === "bot" && row.working > 0 ? (
              <span className="live-txt">{`${row.workLabel}…`}</span>
            ) : (
              previewOf(row.last, dir)
            )}
          </span>
          <Trailing mark={row.mark} workingLabel={row.workLabel} />
        </div>
      </div>
    </a>
  );
}

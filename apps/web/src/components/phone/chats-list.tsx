import type { ConversationDto, MessageDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search, SquarePen } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { orpc } from "../../api/client";
import { type Directory, useDirectory } from "../../api/directory";
import { useOpenPalette } from "../../app/shell-context";
import { formatClock, formatCost } from "../../lib/format";
import { conversationParts } from "../chat/conversation-parts";
import { Trailing, trailingMark } from "../shell/sidebar-row";
import { Avatar, AvatarStack } from "../ui/avatar";
import { Pill } from "../ui/pill";
import { PhoneNavBar } from "./phone-nav-bar";

/** The one-line meaning of a last message: `You: …`, `A → B: …` for a relay, else the text. */
export function previewOf(m: MessageDto | undefined, dir: Directory): string {
  if (!m) return "No messages yet";
  const text = m.text || m.files[0]?.name || "";
  if (m.kind === "relay" && m.relay) {
    return `${dir.botName(m.relay.fromBotId)} → ${dir.botName(m.relay.toBotId)}: ${text}`;
  }
  return m.author.kind === "user" ? `You: ${text}` : text;
}

/** Newest conversation first; ones without a message keep their order at the end. */
const byRecent = (a: ConversationDto, b: ConversationDto) =>
  (b.lastMessage?.at ?? 0) - (a.lastMessage?.at ?? 0);

/**
 * `/` on the phone: large "Chats" title, New chat (opens the palette), search by name, the live
 * row when any bot works (opens Activity) and one 76 px row per conversation.
 */
export function ChatsList() {
  const navigate = useNavigate();
  const openPalette = useOpenPalette();
  const dir = useDirectory();
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];
  const questions = useQuery(orpc.questions.pending.queryOptions()).data ?? [];
  const [term, setTerm] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const now = Date.now();

  const working = status.filter((b) => b.working);
  const rows = [...dir.conversations].sort(byRecent).filter((c) => {
    const { bot, group } = conversationParts(dir, c);
    return (group?.name ?? bot?.name ?? c.title).toLowerCase().includes(term.trim().toLowerCase());
  });

  return (
    <>
      <PhoneNavBar
        title="Chats"
        large
        scrollRef={scroll}
        right={
          <button type="button" className="nb" aria-label="New chat" onClick={openPalette}>
            <SquarePen strokeWidth={1.75} />
          </button>
        }
      />
      <div className="ios-scroll" ref={scroll}>
        <div className="large">Chats</div>
        <div className="ios-search">
          <Search strokeWidth={1.75} />
          <input
            placeholder="Search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            aria-label="Search chats"
          />
        </div>
        {working.length > 0 && (
          <button type="button" className="live" onClick={() => void navigate("/ops")}>
            <AvatarStack
              items={working.map((b) => ({
                src: dir.bots.get(b.botId)?.avatarUrl,
                name: b.name,
                working: true,
              }))}
            />
            <span className="grow">
              <b>
                {working.length} {working.length === 1 ? "bot" : "bots"} working
              </b>
              <span className="t2" style={{ display: "block" }}>
                {approvals.length > 0 && `${approvals.length} approval waiting · `}
                {formatCost(status.reduce((sum, b) => sum + b.spendToday, 0))} today
              </span>
            </span>
            <ChevronRight className="chev" strokeWidth={1.75} />
          </button>
        )}
        <div>
          {rows.map((c) => {
            const { bot, group } = conversationParts(dir, c);
            const name = group?.name ?? bot?.name ?? c.title;
            const live = bot && status.find((b) => b.botId === bot.id && b.working);
            const approvalCount = approvals.filter((a) => a.conversationId === c.id).length;
            const approval = approvalCount > 0;
            const ask = questions.some((q) => q.conversationId === c.id);
            const members = (group?.members ?? []).slice(0, 2).map((id) => dir.bots.get(id));
            return (
              <a
                key={c.id}
                className="crow"
                href={`/c/${c.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  void navigate(`/c/${c.id}`);
                }}
              >
                {group && !group.avatarUrl ? (
                  <span className="gav">
                    {members.map((m, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: two static faces
                      <Avatar key={i} src={m?.avatarUrl} name={m?.name ?? ""} size={34} />
                    ))}
                  </span>
                ) : (
                  <Avatar
                    src={group?.avatarUrl ?? bot?.avatarUrl ?? c.avatarUrl}
                    name={name}
                    size={52}
                    working={Boolean(live)}
                  />
                )}
                <div className="grow">
                  <div className="l1">
                    <b>{name}</b>
                    <time>{c.lastMessage ? formatClock(c.lastMessage.at, now) : ""}</time>
                    {/* Same priority as the sidebar; the working label lives on line 2. */}
                    <Trailing
                      mark={trailingMark({
                        approvals: approvalCount,
                        unread: c.unread,
                        working: false,
                      })}
                    />
                  </div>
                  <div className="l2">
                    {approval ? (
                      <Pill tone="amber">Approval</Pill>
                    ) : (
                      ask && <Pill tone="blue">Question</Pill>
                    )}{" "}
                    {live ? (
                      <span
                        style={{ color: "var(--tint-text)" }}
                      >{`${live.label || "Working"}…`}</span>
                    ) : (
                      previewOf(c.lastMessage, dir)
                    )}
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      </div>
    </>
  );
}

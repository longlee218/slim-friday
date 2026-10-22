import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useChatActions } from "../chat-actions/use-chat-actions";
import { useChat } from "../chat/chat-store";
import type { Chat, DirectChat } from "../chat/chat-types";
import { ROLE_LABEL } from "../chat/role-labels";
import { timeLabel } from "../chat/time-label";
import { Avatar, ChatAvatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { EXIT_FAST, SPRING_SOFT } from "../ui/motion-presets";
import { AgentPage } from "./agent-page";
import { GroupMemoryPage } from "./group-memory-page";
import { ActionRow, Group, Meter, NavRow } from "./inspector-parts";

/** Sub-page open in the inspector: one teammate's instructions and memory, or the group memory. */
type Page = { kind: "agent"; teammateId: string } | { kind: "groupMemory" };

/** Slide in from the right edge: full width on phone, a short offset beside the chat elsewhere. */
function slide(phone: boolean) {
  const x = phone ? "100%" : 28;
  return {
    initial: { opacity: phone ? 1 : 0, x },
    animate: { opacity: 1, x: 0, transition: SPRING_SOFT },
    exit: { opacity: phone ? 1 : 0, x, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as const } },
  };
}

/** Pages push in from the right; the list steps back to the left. */
const push = (dir: 1 | -1) => ({
  initial: { opacity: 0, x: 24 * dir },
  animate: { opacity: 1, x: 0, transition: SPRING_SOFT },
  exit: { opacity: 0, x: -24 * dir, transition: EXIT_FAST },
});

interface Props {
  chat: Chat;
  phone: boolean;
  onClose(): void;
  /** Sub-pages need more width to read; the shell widens the column. */
  onWide(wide: boolean): void;
}

/** Details of the active chat: teammate setup and progress, or group members and limits. */
export function Inspector({ chat, phone, onClose, onWide }: Props) {
  const { teammate } = useChat();
  const [page, setPage] = useState<Page | null>(null);
  const actions = useChatActions();

  // A different chat starts on the details list again.
  useEffect(() => setPage(null), [chat.id]);
  useEffect(() => {
    onWide(page !== null);
    return () => onWide(false);
  }, [page, onWide]);

  const agent = page?.kind === "agent" ? teammate(page.teammateId) : undefined;
  const content =
    agent ? (
      <AgentPage t={agent} onBack={() => setPage(null)} />
    ) : page?.kind === "groupMemory" && chat.kind === "group" ? (
      <GroupMemoryPage chat={chat} onBack={() => setPage(null)} />
    ) : chat.kind === "group" ? (
      <>
        <div className="inspector__who">
          <ChatAvatar chat={chat} size={64} />
          <b>{chat.name}</b>
          <span>{chat.members.length} members</span>
        </div>
        {/* The goal every member reads; tap to edit it, or add one. */}
        <button type="button" className="about" data-empty={!chat.description || undefined} onClick={() => actions.edit(chat)}>
          {chat.description || "Add a description: what this group is for and what done looks like."}
        </button>
        <Group title="Members">
          {chat.members.map((id) => {
            const t = teammate(id);
            if (!t) return null;
            return (
              <NavRow key={id} value={id === chat.router ? "Routes" : undefined} onOpen={() => setPage({ kind: "agent", teammateId: id })}>
                <Avatar name={t.avatar} size={24} />
                <span className="inset__main">
                  {t.name}
                  <small>{ROLE_LABEL[t.role]}</small>
                </span>
              </NavRow>
            );
          })}
        </Group>
        <Group title="Shared">
          <NavRow
            value={chat.memory ? (chat.memoryUpdatedAt ? timeLabel(chat.memoryUpdatedAt) : undefined) : "Empty"}
            onOpen={() => setPage({ kind: "groupMemory" })}
          >
            <span className="inset__main">Group memory</span>
          </NavRow>
        </Group>
        <Group title="Limits per request">
          <Meter label="Turns" value={chat.caps.turns} max={chat.caps.maxTurns} format={String} />
          <Meter label="Cost" value={chat.caps.cost} max={chat.caps.maxCost} format={(v) => `$${v.toFixed(2)}`} />
        </Group>
        <Group title="Manage">
          <ActionRow label="Edit group" onClick={() => actions.edit(chat)} />
          <ActionRow label="Delete group" danger onClick={() => actions.remove(chat)} />
        </Group>
      </>
    ) : (
      <DirectDetails
        chat={chat}
        block={actions.removeBlock(chat)}
        onOpen={(id) => setPage({ kind: "agent", teammateId: id })}
        onRemove={() => actions.remove(chat)}
      />
    );

  return (
    <motion.aside
      className="inspector"
      data-wide={page ? true : undefined}
      aria-label={chat.kind === "group" ? "Group details" : "Teammate details"}
      {...slide(phone)}
    >
      <button type="button" className="tool inspector__close" onClick={onClose} aria-label="Close details">
        <Icon name="x" />
      </button>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={page ? `${page.kind}-${"teammateId" in page ? page.teammateId : ""}` : "list"} className="inspector__view" {...push(page ? 1 : -1)}>
          {content}
        </motion.div>
      </AnimatePresence>
      {actions.dialogs}
    </motion.aside>
  );
}

/** Direct chat details: who, current task, setup, and the way into instructions and memory. */
function DirectDetails(props: { chat: DirectChat; block?: string; onOpen(id: string): void; onRemove(): void }) {
  const { chat, block, onOpen, onRemove } = props;
  const { teammate } = useChat();
  const t = teammate(chat.with);
  if (!t) return null;
  return (
    <>
      <div className="inspector__who">
        <Avatar name={t.avatar} size={64} />
        <b>{t.name}</b>
        <span>{ROLE_LABEL[t.role]}</span>
      </div>
      {t.now && (
        <Group title="Now">
          <Meter label={t.now.title} value={t.now.pct} max={100} format={(v) => `${v}%`} valueOnly />
        </Group>
      )}
      <Group title="Setup">
        <li>
          <span className="inset__main">Template</span>
          <span className="inset__value">{ROLE_LABEL[t.role]}</span>
        </li>
        <li>
          <span className="inset__main">Model</span>
          <span className="inset__value">{t.model}</span>
        </li>
        <NavRow onOpen={() => onOpen(t.id)} value={t.instructions ? "Custom" : "Template"}>
          <span className="inset__main">Instructions</span>
        </NavRow>
        <NavRow
          onOpen={() => onOpen(t.id)}
          value={t.memory ? (t.memoryUpdatedAt ? timeLabel(t.memoryUpdatedAt) : undefined) : "Empty"}
        >
          <span className="inset__main">Memory</span>
        </NavRow>
      </Group>
      <Group title="Manage">
        <ActionRow label="Remove teammate" danger disabled={!!block} hint={block} onClick={onRemove} />
      </Group>
    </>
  );
}

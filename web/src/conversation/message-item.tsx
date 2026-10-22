import { type HTMLMotionProps, motion, useMotionValue, useTransform } from "motion/react";
import type { ReactNode } from "react";
import { useMediaQuery } from "../app/use-media-query";
import { useChat } from "../chat/chat-store";
import type { Chat, Message } from "../chat/chat-types";
import { Avatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { SPRING_SOFT } from "../ui/motion-presets";
import { FileTile, ImageGrid } from "./attachments";
import { FileCard, TaskCard } from "./content-cards";
import { ApprovalCard, QuestionCard } from "./decision-cards";
import { ReplyQuote } from "./reply-quote";

/** Inline `code` only; everything else stays plain text (React escapes it). */
function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part,
      )}
    </>
  );
}

/**
 * Feed item root that rises in when it arrives. My own messages grow from the
 * composer corner (bottom right); teammates' from their avatar (bottom left).
 */
function Arrive({ mine, style, ...rest }: HTMLMotionProps<"div"> & { mine?: boolean }) {
  return (
    <motion.div
      initial={mine ? { opacity: 0, y: 14, scale: 0.9 } : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={SPRING_SOFT}
      style={{ transformOrigin: mine ? "right bottom" : "left bottom", ...style }}
      {...rest}
    />
  );
}

/** Callbacks a feed item needs from the feed. */
export interface FeedActions {
  retry(messageId: string): void;
  reply(messageId: string): void;
  jump(messageId: string): void;
  openImage(attachmentId: string): void;
}

const isMeta = (m?: Message) => !m || m.kind === "stamp" || m.kind === "route" || m.kind === "system";
const sender = (m?: Message) => (m && "from" in m ? m.from : undefined);
/** Leftward swipe distance (px) that triggers a reply on touch screens. A rightward swipe is "back". */
const SWIPE = 56;

interface Props {
  chat: Chat;
  index: number;
  highlighted: boolean;
  actions: FeedActions;
}

/** One feed item; consecutive messages from one sender form a tight group. */
export function MessageItem({ chat, index, highlighted, actions }: Props) {
  const { teammate, runtime } = useChat();
  const touch = useMediaQuery("(pointer: coarse)");
  // Swipe-to-reply: the message follows the finger left; the reply icon fades in on its right.
  const x = useMotionValue(0);
  const hintOpacity = useTransform(x, [0, -SWIPE], [0, 1]);
  const hintScale = useTransform(x, [0, -SWIPE], [0.6, 1]);
  const m = chat.messages[index];

  if (m.kind === "stamp") return <Arrive className="stamp">{m.text}</Arrive>;
  if (m.kind === "system") return <Arrive className="note">{m.text}</Arrive>;
  if (m.kind === "route") {
    const from = teammate(m.from);
    return (
      <Arrive className="note">
        {from && <Avatar name={from.avatar} size={14} />}
        {from?.name} asked {teammate(m.to)?.name}
      </Arrive>
    );
  }

  const prev = chat.messages[index - 1];
  const next = chat.messages[index + 1];
  const first = isMeta(prev) || sender(prev) !== m.from;
  const last = isMeta(next) || sender(next) !== m.from;
  const mine = m.from === "me";
  const decide = (answer: string) => runtime.decide(chat.id, m.id, answer);
  const replyTo = "replyTo" in m ? m.replyTo : undefined;

  let body: ReactNode;
  if (m.kind === "text") {
    const images = m.attachments?.filter((a) => a.type === "image") ?? [];
    const files = m.attachments?.filter((a) => a.type === "file") ?? [];
    body = (
      <>
        {images.length > 0 && <ImageGrid images={images} onOpen={actions.openImage} />}
        {files.map((f) => (
          <FileTile key={f.id} name={f.name} size={f.size} url={f.url} uploading={f.uploading} />
        ))}
        {m.text && (
          <div className="bubble" data-failed={m.failed || undefined}>
            <RichText text={m.text} />
          </div>
        )}
        {m.failed && (
          <button type="button" className="retry" onClick={() => actions.retry(m.id)}>
            <Icon name="retry" size={12} /> Not sent. Retry
          </button>
        )}
        {m.handoffTo && (
          <span className="handoff">
            <Icon name="arrow" size={12} />
            {teammate(m.handoffTo)?.name}
          </span>
        )}
      </>
    );
  } else if (m.kind === "file") body = <FileCard m={m} />;
  else if (m.kind === "task") body = <TaskCard m={m} />;
  else if (m.kind === "approval") body = <ApprovalCard m={m} onDecide={decide} />;
  else body = <QuestionCard m={m} onDecide={decide} />;

  const replyButton = (
    <button type="button" className="msg__reply" onClick={() => actions.reply(m.id)} aria-label="Reply" title="Reply">
      <Icon name="reply" size={14} />
    </button>
  );
  const stack = (
    <div className="msg__body">
      {replyTo && <ReplyQuote target={chat.messages.find((x) => x.id === replyTo)} onJump={actions.jump} />}
      {body}
    </div>
  );
  const who = mine ? undefined : teammate(m.from);

  return (
    <Arrive
      mine={mine}
      className={mine ? "msg msg--mine" : "msg"}
      id={`msg-${m.id}`}
      data-first={first || undefined}
      data-highlight={highlighted || undefined}
      style={{ x }}
      drag={touch ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.5, right: 0 }}
      dragDirectionLock
      onDragEnd={(_, info) => {
        if (info.offset.x < -SWIPE) actions.reply(m.id);
      }}
    >
      {touch && (
        <motion.span className="msg__swipe" style={{ opacity: hintOpacity, scale: hintScale }} aria-hidden="true">
          <Icon name="reply" size={14} />
        </motion.span>
      )}
      {first && chat.kind === "group" && !mine && <span className="msg__by">{who?.name}</span>}
      <div className="msg__lane">
        {mine ? (
          <>
            {replyButton}
            {stack}
          </>
        ) : (
          <>
            {last ? <Avatar name={who?.avatar ?? "lead"} size={24} /> : <span className="msg__gap" />}
            {stack}
            {replyButton}
          </>
        )}
      </div>
    </Arrive>
  );
}

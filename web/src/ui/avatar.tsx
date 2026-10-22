import { useChat } from "../chat/chat-store";
import type { Chat } from "../chat/chat-types";

/** Round role avatar from /avatars. */
export function Avatar({ name, size }: { name: string; size: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size }}>
      <img src={`/avatars/${name}.webp`} alt="" width={size} height={size} draggable={false} />
    </span>
  );
}

/** Teammate avatar for a direct chat; two overlapped members for a group. */
export function ChatAvatar({ chat, size }: { chat: Chat; size: number }) {
  const { teammate } = useChat();
  if (chat.kind === "direct") return <Avatar name={teammate(chat.with)?.avatar ?? "lead"} size={size} />;
  const [a, b] = chat.members.filter((m) => m !== chat.router).slice(0, 2);
  const small = Math.round(size * 0.7);
  return (
    <span className="avatar-duo" style={{ width: size, height: size }}>
      <Avatar name={teammate(a)?.avatar ?? "lead"} size={small} />
      <Avatar name={teammate(b)?.avatar ?? "lead"} size={small} />
    </span>
  );
}

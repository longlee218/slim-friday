import { useChat } from "../chat/chat-store";
import type { Message } from "../chat/chat-types";
import { firstImage, snippet } from "./message-snippet";

/** Display name of a message's sender ("You" for the owner). */
export function useSenderName(): (m: Message) => string {
  const { teammate } = useChat();
  return (m) => {
    const from = "from" in m ? m.from : undefined;
    return from === "me" ? "You" : (from && teammate(from)?.name) || "";
  };
}

/**
 * Quoted message shown above a reply: a faded, smaller bubble.
 * Clicking it scrolls to the original and flashes it.
 */
export function ReplyQuote({ target, onJump }: { target: Message | undefined; onJump(id: string): void }) {
  const name = useSenderName();
  if (!target) return <span className="quote quote--gone">Original message is gone</span>;
  const thumb = firstImage(target);
  return (
    <button type="button" className="quote" onClick={() => onJump(target.id)} aria-label={`Go to message from ${name(target)}`}>
      {thumb && <img className="quote__thumb" src={thumb} alt="" />}
      <span className="quote__text">
        <b>{name(target)}</b>
        <span>{snippet(target)}</span>
      </span>
    </button>
  );
}

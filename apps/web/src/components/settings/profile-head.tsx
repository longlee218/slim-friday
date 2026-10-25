import { MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

/**
 * The head of a bot or group page (Messenger profile): a big centred face, the name as a large
 * title, a subtitle, then round quick actions.
 */
export function ProfileHead({
  face,
  title,
  sub,
  actions,
}: {
  face: ReactNode;
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="profile-head">
      {face}
      <h2>{title}</h2>
      {sub && <div className="r">{sub}</div>}
      {actions && <div className="insp-actions">{actions}</div>}
    </div>
  );
}

/** Round "Chat" quick action that opens a conversation (named "Open chat" for screen readers). */
export function ChatAction({ to }: { to: string }) {
  return (
    <Link className="qa" to={to} aria-label="Open chat">
      <span className="qa-ico">
        <MessageCircle size={18} strokeWidth={1.75} />
      </span>
      <span className="qa-l">Chat</span>
    </Link>
  );
}

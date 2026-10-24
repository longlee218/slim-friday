import { toast } from "sonner";
import { useDirectory } from "../../api/directory";
import type { Notify } from "../../events/apply-effects";
import { Avatar } from "../ui/avatar";
import { PANEL_MIN } from "./panels";
import { useAppNavigate } from "./use-app-navigate";

export interface NotifyInput {
  conversationId: string;
  botId?: string;
  /** Bot name (the caller maps a bot id to its name). */
  title: string;
  text: string;
  avatarSrc?: string;
}

/**
 * Bottom-right toast for a message or card that arrives away from its chat; a click opens the
 * conversation. Desktop only: the phone shows unread badges instead of toasts.
 */
export function notifyToast(n: NotifyInput, open: (conversationId: string) => void): void {
  if (window.innerWidth < PANEL_MIN.phone) return;
  toast.custom(
    (id) => (
      <button
        type="button"
        className="toast-card"
        onClick={() => {
          toast.dismiss(id);
          open(n.conversationId);
        }}
      >
        <Avatar src={n.avatarSrc} name={n.title} size={30} />
        <span>
          <b>{n.title}</b>
          <span className="t2">{n.text.slice(0, 90)}</span>
        </span>
      </button>
    ),
    { duration: 3600, position: "bottom-right" },
  );
}

/**
 * The `notify` callback for `applyEffects`: a message notify carries the bot id as its title, so
 * it is mapped to the bot name (the id stays when the bot is unknown); approval and question
 * notifies already carry the name.
 */
export function useNotifier(): Notify {
  const { bots, botName } = useDirectory();
  const go = useAppNavigate();
  return (n) =>
    notifyToast(
      {
        ...n,
        title: n.botId && n.title === n.botId ? botName(n.botId) : n.title,
        avatarSrc: n.botId ? bots.get(n.botId)?.avatarUrl : undefined,
      },
      (id) => go(`/c/${id}`),
    );
}

import { useQuery } from "@tanstack/react-query";
import { Gauge, MessageCircle, Settings, SquareKanban } from "lucide-react";
import { useNavigate } from "react-router";
import { orpc } from "../../api/client";
import { type PhoneTab, TAB_ROOT } from "./phone-stack";

const TABS = [
  { id: "chats", label: "Chats", Icon: MessageCircle },
  { id: "tickets", label: "Tickets", Icon: SquareKanban },
  { id: "activity", label: "Activity", Icon: Gauge },
  { id: "settings", label: "Settings", Icon: Settings },
] as const satisfies readonly { id: PhoneTab; label: string; Icon: unknown }[];

/**
 * Bottom tab bar (50 px + safe area). Slides down while a view is pushed; the Activity tab
 * carries a red badge with the approvals waiting for the owner.
 */
export function TabBar({ active, hidden }: { active: PhoneTab; hidden: boolean }) {
  const navigate = useNavigate();
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data?.length ?? 0;
  return (
    <nav className={hidden ? "tabbar hidden" : "tabbar"} aria-label="Tabs" inert={hidden}>
      {TABS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          className={id === active ? "on" : undefined}
          aria-current={id === active ? "page" : undefined}
          onClick={() => void navigate(TAB_ROOT[id])}
        >
          <Icon strokeWidth={1.75} />
          <span>{label}</span>
          {id === "activity" && approvals > 0 && <span className="tb">{approvals}</span>}
        </button>
      ))}
    </nav>
  );
}

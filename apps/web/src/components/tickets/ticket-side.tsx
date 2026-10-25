import type { TicketDto } from "@friday/contracts";
import { ChevronRight, MessageCircle, Users } from "lucide-react";
import { toast } from "sonner";
import { useDirectory } from "../../api/directory";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Button } from "../ui/button";
import { TicketDetail } from "./ticket-detail";
import { StatusDot } from "./ticket-status";
import { useUpdateTicket } from "./use-update-ticket";

/** Side column of the ticket page: properties, conversation, related tickets and Close ticket. */
export function TicketSide({ ticket: t, related }: { ticket: TicketDto; related: TicketDto[] }) {
  const dir = useDirectory();
  const go = useAppNavigate();
  const update = useUpdateTicket(t.ref);
  const conv = t.conversationId
    ? dir.conversations.find((c) => c.id === t.conversationId)
    : undefined;
  return (
    <aside className="tside">
      <div className="panel" style={{ padding: "4px 14px 8px" }}>
        <TicketDetail key={t.ref} ticket={t} />
      </div>
      {t.conversationId && (
        <>
          <h3 className="tp-h">Conversation</h3>
          {/* biome-ignore lint/a11y/useSemanticElements: the prototype's panel row is a div link */}
          <div
            className="panel tlink"
            role="link"
            tabIndex={0}
            onClick={() => go(`/c/${t.conversationId}`)}
            onKeyDown={(e) => e.key === "Enter" && go(`/c/${t.conversationId}`)}
          >
            {conv?.kind === "group" ? <Users /> : <MessageCircle />}
            <span>{conv?.title ?? t.conversationId}</span>
            <ChevronRight className="chev" />
          </div>
        </>
      )}
      {related.length > 0 && (
        <>
          <h3 className="tp-h">Related</h3>
          <div className="panel">
            {related.map((r) => (
              // biome-ignore lint/a11y/useSemanticElements: the prototype's row is a div link
              <div
                className="tlink"
                key={r.ref}
                role="link"
                tabIndex={0}
                onClick={() => go(`/tickets/${r.ref}`)}
                onKeyDown={(e) => e.key === "Enter" && go(`/tickets/${r.ref}`)}
              >
                <StatusDot status={r.status} />
                <span className="tk">{r.ref}</span>
                <span className="grow">{r.title}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <Button
        variant="danger"
        style={{ width: "100%", justifyContent: "center", marginTop: 14 }}
        onClick={() => {
          // Leave the page only once the close is saved; a failure keeps the page and its toast.
          update.mutate(
            { ref: t.ref, status: "closed" },
            {
              onSuccess: () => {
                toast(`${t.ref} closed.`);
                go("/tickets");
              },
            },
          );
        }}
      >
        Close ticket
      </Button>
    </aside>
  );
}

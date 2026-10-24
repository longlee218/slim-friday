import type { TicketDto } from "@friday/contracts";
import { type ReactNode, useState } from "react";
import { useDirectory } from "../../api/directory";
import { formatClock } from "../../lib/format";
import { Avatar } from "../ui/avatar";
import { Button } from "../ui/button";
import { AssigneeSelect, PrioritySelect, StatusSelect } from "./ticket-fields";
import { useUpdateTicket } from "./use-update-ticket";

/** Label / control row of the property list (`.prop` with centred controls). */
const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="prop" style={{ alignItems: "center" }}>
    <span>{label}</span>
    {children}
  </div>
);

/**
 * Property rows shared by the drawer and the ticket page: status, assignee and priority selects,
 * created / updated, and the blocked reason. Choosing Blocked first asks "Why blocked?" and saves
 * status and reason together; every other change saves at once.
 */
export function TicketDetail({ ticket: t }: { ticket: TicketDto }) {
  const dir = useDirectory();
  const update = useUpdateTicket(t.ref);
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  const creator = t.createdBy.kind === "bot" ? t.createdBy.botId : null;
  const now = Date.now();

  return (
    <>
      <Row label="Status">
        <StatusSelect
          value={t.status}
          onChange={(status) => {
            if (status === "blocked") return setAsking(true);
            setAsking(false);
            update.mutate({ ref: t.ref, status });
          }}
        />
      </Row>
      {asking && (
        <div style={{ padding: "4px 0 8px" }}>
          <input
            className="field"
            aria-label="Why blocked?"
            placeholder="Why blocked?"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
          />
          <div
            className="acts"
            style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6 }}
          >
            <Button onClick={() => setAsking(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!why.trim()}
              onClick={() => {
                update.mutate({ ref: t.ref, status: "blocked", blockedReason: why.trim() });
                setAsking(false);
                setWhy("");
              }}
            >
              Block
            </Button>
          </div>
        </div>
      )}
      <Row label="Assignee">
        <AssigneeSelect
          value={t.assigneeBotId ?? null}
          onChange={(assignee) => update.mutate({ ref: t.ref, assignee })}
        />
      </Row>
      <Row label="Priority">
        <PrioritySelect
          value={t.priority}
          onChange={(priority) => update.mutate({ ref: t.ref, priority })}
        />
      </Row>
      <div className="prop">
        <span>Created</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          {creator && (
            <Avatar src={dir.bots.get(creator)?.avatarUrl} name={dir.botName(creator)} size={16} />
          )}
          {creator ? dir.botName(creator) : t.createdBy.kind === "user" ? "You" : "System"} ·{" "}
          {formatClock(t.createdAt, now)}
        </span>
      </div>
      <div className="prop">
        <span>Updated</span>
        <span>{formatClock(t.updatedAt, now)}</span>
      </div>
      {t.status === "blocked" && t.blockedReason && (
        <div className="prop">
          <span>Blocked</span>
          <span style={{ color: "var(--red)" }}>{t.blockedReason}</span>
        </div>
      )}
    </>
  );
}

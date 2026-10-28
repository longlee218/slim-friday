import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Link as LinkIcon, MessageCircle } from "lucide-react";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { BotMarkdown } from "../markdown/bot-markdown";
import { useCopy } from "../markdown/use-copy";
import { Toolbar } from "../shell/toolbar";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Button } from "../ui/button";
import { taskIndexAtLine, taskProgress, toggleTask } from "./task-list";
import { TicketSide } from "./ticket-side";
import { PriorityPill, StatusPill } from "./ticket-status";
import { TicketTimeline } from "./ticket-timeline";
import { useCommentDraft } from "./use-comment-draft";
import { useUpdateTicket } from "./use-update-ticket";

/** Comment box under the activity; posting wakes the assignee on the server. */
function CommentBox({ ticketRef, assignee }: { ticketRef: string; assignee?: string }) {
  const { text, setText, note, disabled, send } = useCommentDraft(ticketRef);
  return (
    <div className="tp-comment">
      <textarea
        className="field"
        rows={3}
        aria-label="Comment"
        placeholder={`Comment.${assignee ? ` ${assignee} is woken when you comment.` : ""}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {note && <div className="t2">{note}</div>}
      <div className="acts">
        <Button variant="primary" disabled={disabled} onClick={send}>
          Comment
        </Button>
      </div>
    </div>
  );
}

/** Toolbar with the "Tickets > ref" crumb and optional actions. */
function PageToolbar({ ticketRef, actions }: { ticketRef: string; actions?: React.ReactNode }) {
  const go = useAppNavigate();
  return (
    <Toolbar
      title={
        <span className="crumb">
          <button type="button" className="linkbtn" onClick={() => go("/tickets")}>
            Tickets
          </button>
          <ChevronRight />
          <span className="mono">{ticketRef}</span>
        </span>
      }
      actions={actions}
    />
  );
}

/**
 * Full page of a ticket (prototype `ticketPage`): crumb and actions, ref, status and priority
 * pills, title,
 * task progress, the description with clickable task boxes, the activity rail, a comment box
 * and the side column. A ref the server does not know shows "doesn't exist".
 */
export function TicketPage({ ticketRef }: { ticketRef: string }) {
  const go = useAppNavigate();
  const dir = useDirectory();
  const get = useQuery(orpc.tickets.get.queryOptions({ input: { ref: ticketRef } }));
  const update = useUpdateTicket(ticketRef);
  const [copied, copy] = useCopy(`${window.location.origin}/tickets/${ticketRef}`);
  const t = get.data?.ticket;

  if (!t) {
    const missing = (get.error as { code?: string } | null)?.code === "NOT_FOUND";
    return (
      <section className="pane">
        <PageToolbar ticketRef={ticketRef} />
        <div className="content">
          <div className="empty">
            {missing ? (
              <>
                <h3>{ticketRef} doesn't exist</h3>
                <p>It may have been deleted.</p>
                <Button onClick={() => go("/tickets")}>Open the board</Button>
              </>
            ) : (
              <h3>{get.isError ? "Could not load the ticket." : "Loading"}</h3>
            )}
          </div>
        </div>
      </section>
    );
  }

  const md = t.description ?? "";
  const { done, all } = taskProgress(md);
  const assignee = t.assigneeBotId ? dir.botName(t.assigneeBotId) : undefined;
  // A tick sends the whole toggled text; the hook adds the cached `updatedAt`.
  const onToggleTask = (line: number) => {
    const i = taskIndexAtLine(md, line);
    if (i >= 0) update.mutate({ ref: t.ref, description: toggleTask(md, i) });
  };

  return (
    <section className="pane">
      <PageToolbar
        ticketRef={ticketRef}
        actions={
          <>
            <Button onClick={copy}>
              <LinkIcon size={14} strokeWidth={1.75} />
              {copied ? "Copied" : "Copy link"}
            </Button>
            {t.assigneeBotId && (
              <Button style={{ marginLeft: 6 }} onClick={() => go(`/c/bot:${t.assigneeBotId}`)}>
                <MessageCircle size={14} strokeWidth={1.75} />
                Chat with {assignee}
              </Button>
            )}
          </>
        }
      />
      <div className="content">
        <div className="tpage">
          <div className="tmain">
            <div className="td-pills tp-pills">
              <span className="td-ref">{t.ref}</span>
              <StatusPill status={t.status} />
              <PriorityPill priority={t.priority} />
            </div>
            <h1 className="tp-title">{t.title}</h1>
            {all > 0 && (
              <div className="tp-progress">
                <div className="meter">
                  <i style={{ width: `${(done / all) * 100}%` }} />
                </div>
                <span className="num">
                  {done} of {all} done
                </span>
              </div>
            )}
            <div className="tp-desc">
              <BotMarkdown
                text={md || "No description."}
                onToggleTask={onToggleTask}
                isTaskLine={(line) => taskIndexAtLine(md, line) >= 0}
              />
            </div>
            <h3 className="tp-h">Activity</h3>
            <TicketTimeline items={get.data?.timeline ?? []} />
            <CommentBox ticketRef={t.ref} assignee={assignee} />
          </div>
          <TicketSide ticket={t} related={get.data?.related ?? []} />
        </div>
      </div>
    </section>
  );
}

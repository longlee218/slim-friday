import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ChevronRight, Link as LinkIcon, MessageCircle, Users } from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { BotMarkdown } from "../markdown/bot-markdown";
import { useCopy } from "../markdown/use-copy";
import { PhoneNavBar } from "../phone/phone-nav-bar";
import { useBackLabel } from "../phone/phone-shell";
import { taskIndexAtLine, toggleTask } from "./task-list";
import { TicketDetail } from "./ticket-detail";
import { TicketTimeline } from "./ticket-timeline";
import { useCommentTicket } from "./use-comment-ticket";
import { useUpdateTicket } from "./use-update-ticket";

/** Comment composer pinned under the scroll body (prototype `.ios-composer`). */
function CommentComposer({ ticketRef }: { ticketRef: string }) {
  const comment = useCommentTicket(ticketRef);
  const [text, setText] = useState("");
  const body = text.trim();
  return (
    <div className="ios-composer">
      <div className="box">
        <textarea
          rows={1}
          aria-label="Comment"
          placeholder="Comment"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="send"
          aria-label="Send comment"
          disabled={!body || comment.isPending}
          onClick={() => comment.mutate(body, { onSuccess: () => setText("") })}
        >
          <ArrowUp />
        </button>
      </div>
    </div>
  );
}

/**
 * `/tickets/:ref` on the phone (prototype `ticket` push): the title, the property rows (status
 * in a bottom sheet), description with tickable task boxes, the conversation row, the activity,
 * a Close ticket row and the comment composer. Back reads "Tickets".
 */
export function PhoneTicketView({ ticketRef }: { ticketRef: string }) {
  const navigate = useNavigate();
  const dir = useDirectory();
  const back = useBackLabel() ?? "Tickets";
  const scroll = useRef<HTMLDivElement>(null);
  const get = useQuery(orpc.tickets.get.queryOptions({ input: { ref: ticketRef } }));
  const update = useUpdateTicket(ticketRef);
  const [copied, copy] = useCopy(`${window.location.origin}/tickets/${ticketRef}`);
  const t = get.data?.ticket;

  if (!t) {
    const missing = (get.error as { code?: string } | null)?.code === "NOT_FOUND";
    return (
      <>
        <PhoneNavBar title={ticketRef} back={back} scrollRef={scroll} />
        <div className="ios-scroll" ref={scroll}>
          <div className="empty">
            <h3>
              {missing
                ? `${ticketRef} doesn't exist`
                : get.isError
                  ? "Could not load the ticket."
                  : "Loading"}
            </h3>
          </div>
        </div>
      </>
    );
  }

  const md = t.description ?? "";
  const conv = t.conversationId
    ? dir.conversations.find((c) => c.id === t.conversationId)
    : undefined;
  // A tick sends the whole toggled text; the hook adds the cached `updatedAt`.
  const onToggleTask = (line: number) => {
    const i = taskIndexAtLine(md, line);
    if (i >= 0) update.mutate({ ref: t.ref, description: toggleTask(md, i) });
  };
  // Leave the view only once the close is saved; a failure keeps it and its toast.
  const close = () =>
    update.mutate(
      { ref: t.ref, status: "closed" },
      {
        onSuccess: () => {
          toast(`${t.ref} closed.`);
          void navigate("/tickets");
        },
      },
    );

  return (
    <div className="ios-chat">
      <PhoneNavBar
        title={t.ref}
        back={back}
        scrollRef={scroll}
        right={
          <button type="button" className="nb" aria-label="Copy link" onClick={copy}>
            {copied ? "Copied" : <LinkIcon strokeWidth={1.75} />}
          </button>
        }
      />
      <div
        className="ios-scroll nt"
        ref={scroll}
        style={{ paddingTop: "calc(var(--safe-t) + 60px)" }}
      >
        <div style={{ padding: "6px 16px 14px", font: "650 22px/1.25 var(--font-display)" }}>
          {t.title}
        </div>
        <div className="inset ph-props" style={{ padding: "2px 16px" }}>
          <TicketDetail key={t.ref} ticket={t} phone />
        </div>
        <div className="inset-h">Description</div>
        <div className="inset md" style={{ padding: "12px 16px", fontSize: 15 }}>
          <BotMarkdown
            text={md || "No description."}
            onToggleTask={onToggleTask}
            isTaskLine={(line) => taskIndexAtLine(md, line) >= 0}
          />
        </div>
        {t.conversationId && (
          <div className="inset">
            <a
              className="irow ic"
              href={`/c/${t.conversationId}`}
              onClick={(e) => {
                e.preventDefault();
                void navigate(`/c/${t.conversationId}`);
              }}
            >
              {conv?.kind === "group" ? <Users /> : <MessageCircle />}
              <div className="grow">{conv?.title ?? t.conversationId}</div>
              <ChevronRight className="chev" strokeWidth={1.75} />
            </a>
          </div>
        )}
        <div className="inset-h">Activity</div>
        <div className="inset" style={{ padding: "6px 16px" }}>
          <TicketTimeline items={get.data?.timeline ?? []} />
        </div>
        <div className="inset">
          <button type="button" className="irow danger" onClick={close}>
            <div className="grow" style={{ textAlign: "center" }}>
              Close ticket
            </div>
          </button>
        </div>
      </div>
      <CommentComposer ticketRef={t.ref} />
    </div>
  );
}

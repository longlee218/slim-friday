import type { ConversationDto, MessageDto, MessageReaction } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type DragEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { type LiveRun, liveRunKey, type Receipt, receiptsKey } from "../../events/client-keys";
import { conversationParts } from "./conversation-parts";
import { MessageSheet } from "./message-sheet";
import { usePendingSends } from "./pending-sends";
import { type BarState, barItemAt, DISMISS_TRAVEL_PX, MORE, ReactionBar } from "./reaction-bar";
import { useSwipeToReply } from "./swipe-to-reply";
import { buildTranscriptItems } from "./transcript-items";
import { TranscriptRow } from "./transcript-row";
import { useConversationMessages } from "./use-conversation-messages";
import { useLocal } from "./use-local-cache";
import { useMarkRead } from "./use-mark-read";
import { useSendMessage } from "./use-send-message";
import { useTranscriptScroll } from "./use-transcript-scroll";

const OVERSCAN = 8;
const ESTIMATE_PX = 96;

export interface TranscriptProps {
  conversation: ConversationDto;
  phone: boolean;
  onReply(m: MessageDto): void;
  /** Files dropped anywhere on the transcript (the composer starts their uploads). */
  onDropFiles(files: File[]): void;
}

/**
 * The conversation: virtualised rows (overscan 8, column of 800 px), oldest first. Opens on
 * the newest item, follows new ones only while within 80 px of the bottom, loads older pages
 * near the top without moving the message being read, marks the conversation read, and takes
 * dropped files. On the phone, bot messages swipe to reply and hold for the sheet.
 */
export function Transcript({ conversation, phone, onReply, onDropFiles }: TranscriptProps) {
  const dir = useDirectory();
  const q = useConversationMessages(conversation.id);
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];
  const questions = useQuery(orpc.questions.pending.queryOptions()).data ?? [];
  const receipts = useLocal<Record<string, Receipt>>(receiptsKey(), {});
  const runs = useLocal<Record<string, LiveRun>>(liveRunKey(conversation.id), {});
  const pendingSends = usePendingSends();
  const sender = useSendMessage();

  const pages = q.data?.pages;
  const pending = useMemo(
    () => Object.fromEntries(Object.entries(pendingSends).map(([id, p]) => [id, p.state])),
    [pendingSends],
  );
  const items = useMemo(
    () =>
      buildTranscriptItems({
        pages: pages ?? [],
        approvals,
        questions,
        receipts,
        runs,
        conversationId: conversation.id,
        pending,
      }),
    [pages, approvals, questions, receipts, runs, conversation.id, pending],
  );

  const { bot, group } = conversationParts(dir, conversation);
  const members = group?.members ?? (bot ? [bot.id] : []);
  const newestId = pages?.[0]?.find((m) => m.id > 0)?.id;

  // Messages with an id above everything loaded at mount arrived over the stream.
  const baseline = useRef<number | undefined>(undefined);
  if (baseline.current === undefined && pages) {
    baseline.current = Math.max(0, ...pages.flat().map((m) => m.id));
  }

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  // Offset of the list inside the scroller (toolbar padding + transcript padding).
  useLayoutEffect(() => {
    if (!scroller || !inner.current) return;
    const m =
      inner.current.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    setMargin(Number.isFinite(m) ? m : 0);
  }, [scroller]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller,
    estimateSize: () => ESTIMATE_PX,
    overscan: OVERSCAN,
    scrollMargin: margin,
    getItemKey: (i) => items[i]?.key ?? i,
  });

  const scroll = useTranscriptScroll({
    scroller,
    itemCount: items.length,
    lastKey: items.at(-1)?.key,
    totalSize: virtualizer.getTotalSize(),
    pageCount: pages?.length ?? 0,
    hasOlder: q.hasNextPage,
    loadingOlder: q.isFetchingNextPage,
    loadOlder: () => void q.fetchNextPage(),
  });

  useMarkRead(conversation.id, newestId, scroll.atBottom);

  // Phone gestures.
  const [sheet, setSheet] = useState<MessageDto | null>(null);
  const byId = (id: number) =>
    items.flatMap((i) => (i.kind === "message" && i.message.id === id ? [i.message] : []))[0];
  // A reaction is an owner reply of one emoji; it wakes no run by itself, so no live run is shown for it.
  const onReact = (m: MessageDto, emoji: MessageReaction) =>
    void sender.send({
      payload: { conversationId: conversation.id, text: emoji, replyTo: m.id },
      route: { botIds: [], reason: "reply" },
    });

  const [bar, setBar] = useState<BarState | null>(null);
  useSwipeToReply(phone ? scroller : null, {
    onReply: (id) => {
      const m = byId(id);
      if (m) onReply(m);
    },
    onHold: (id, at) => {
      const box = scroller?.querySelector(`.msg[data-mi="${id}"]`)?.getBoundingClientRect();
      if (box) {
        setBar({
          messageId: id,
          top: box.top,
          bottom: box.bottom,
          down: true,
          origin: at,
          point: at,
        });
      }
    },
    onHoldMove: (at) => setBar((b) => b && { ...b, point: at }),
    onHoldEnd: (at) => {
      // Read from the render, not inside a state updater: React may run an updater twice.
      if (!bar) return;
      const item = barItemAt(at);
      const m = byId(bar.messageId);
      if (item === MORE) setSheet(m ?? null);
      else if (item && m) onReact(m, item);
      // Lifted on nothing: a hold that stayed put leaves the bar open for a tap, a drag away closes it.
      const travel = Math.hypot(at.x - bar.origin.x, at.y - bar.origin.y);
      setBar(item || travel > DISMISS_TRAVEL_PX ? null : { ...bar, down: false, point: at });
    },
    onDoubleTap: (id) => {
      const m = byId(id);
      if (!m) return;
      navigator.vibrate?.(8);
      onReact(m, "👍");
    },
  });

  // The message the bar is for stays marked while the bar is open.
  const heldId = bar?.messageId;
  useLayoutEffect(() => {
    if (heldId === undefined) return;
    const m = scroller?.querySelector(`.msg[data-mi="${heldId}"]`);
    m?.classList.add("held");
    return () => m?.classList.remove("held");
  }, [scroller, heldId]);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onDropFiles(files);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: scroll container and file drop zone
    <div
      ref={setScroller}
      className={phone ? "ios-scroll" : "content"}
      onScroll={scroll.onScroll}
      onWheel={scroll.markTouched}
      onTouchStart={scroll.markTouched}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <div className="transcript">
        {q.isFetchingNextPage && <div className="loading-older">Loading earlier messages…</div>}
        <div ref={inner} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((v) => {
            const item = items[v.index];
            if (!item) return null;
            return (
              <div
                key={item.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${v.start - margin}px)`,
                }}
              >
                <TranscriptRow
                  item={item}
                  phone={phone}
                  members={members}
                  routeOf={(id) => pendingSends[id]?.route}
                  isFresh={(m) => m.id > (baseline.current ?? 0)}
                  onReply={onReply}
                  onReact={onReact}
                  onRetry={(id) => void sender.retry(id)}
                />
              </div>
            );
          })}
        </div>
      </div>
      {phone && bar && (
        <ReactionBar
          state={bar}
          onPick={(emoji) => {
            const m = byId(bar.messageId);
            if (m) onReact(m, emoji);
            setBar(null);
          }}
          onMore={() => {
            setSheet(byId(bar.messageId) ?? null);
            setBar(null);
          }}
          onDismiss={() => setBar(null)}
        />
      )}
      {phone && sheet && (
        <MessageSheet
          message={sheet}
          open
          onOpenChange={(o) => !o && setSheet(null)}
          onReply={() => onReply(sheet)}
          onCopy={() => {
            void navigator.clipboard?.writeText(sheet.text).catch(() => {});
            toast("Message copied.");
          }}
        />
      )}
    </div>
  );
}

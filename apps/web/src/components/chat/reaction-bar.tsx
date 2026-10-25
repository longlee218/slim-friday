import { MESSAGE_REACTIONS, type MessageReaction } from "@friday/contracts";
import { Ellipsis } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Point } from "./swipe-to-reply";

/** Space (px) kept above the bar for the toolbar; a message nearer the top gets the bar below it. */
const TOP_SAFE_PX = 72;
/** Gap (px) between the message and the bar. */
const GAP_PX = 8;
/** Height (px) of the bar, for placing it above the message. */
const BAR_PX = 52;
/** Finger travel (px) after which a release outside the bar dismisses it instead of leaving it open. */
export const DISMISS_TRAVEL_PX = 16;

/** The `data-react` value of the "more" item (Reply and Copy). */
export const MORE = "more";

/** What the bar is over: the message's box, whether the finger is still down, and where it is. */
export interface BarState {
  messageId: number;
  top: number;
  bottom: number;
  /** The finger that opened the bar is still down. */
  down: boolean;
  /** Where the finger first held. */
  origin: Point;
  /** Where the finger is now. */
  point: Point;
}

/** The item under a point: an emoji, `MORE`, or undefined. */
export function barItemAt(p: Point): MessageReaction | typeof MORE | undefined {
  const hit = document.elementFromPoint?.(p.x, p.y)?.closest<HTMLElement>("[data-react]");
  return hit?.dataset.react as MessageReaction | typeof MORE | undefined;
}

export interface ReactionBarProps {
  state: BarState;
  onPick(emoji: MessageReaction): void;
  /** The owner chose the "more" item: show Reply and Copy. */
  onMore(): void;
  onDismiss(): void;
}

/**
 * The reaction bar of the phone: six emoji and a "more" item in a floating pill over the held message.
 * While the finger is down the item under it lifts and grows, and lifting the finger on one picks it; lifting
 * elsewhere leaves the bar open for a tap, and a tap outside closes it. It sits in `document.body`, because
 * the phone views slide with a transform that would break fixed placement.
 */
export function ReactionBar({ state, onPick, onMore, onDismiss }: ReactionBarProps) {
  const above = state.top - BAR_PX - GAP_PX >= TOP_SAFE_PX;
  const top = above ? state.top - BAR_PX - GAP_PX : state.bottom + GAP_PX;
  const under = state.down ? barItemAt(state.point) : undefined;

  // A touch pulse when the finger moves onto another item (Android; iOS Safari has none).
  const prev = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (under && under !== prev.current) navigator.vibrate?.(6);
    prev.current = under;
  }, [under]);

  return createPortal(
    <>
      {!state.down && <div className="rbar-scrim" onPointerDown={onDismiss} aria-hidden />}
      <div
        className={above ? "rbar" : "rbar below"}
        style={{ top }}
        role="toolbar"
        aria-label="Reactions"
      >
        {MESSAGE_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={under === emoji ? "rbar-item on" : "rbar-item"}
            data-react={emoji}
            aria-label={`React ${emoji}`}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
        <button
          type="button"
          className={under === MORE ? "rbar-item more on" : "rbar-item more"}
          data-react={MORE}
          aria-label="Reply or copy"
          onClick={onMore}
        >
          <Ellipsis size={20} strokeWidth={1.75} />
        </button>
      </div>
    </>,
    document.body,
  );
}

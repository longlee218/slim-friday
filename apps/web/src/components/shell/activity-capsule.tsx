import { Popover } from "@base-ui/react/popover";
import type { BotStatusDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { formatCost } from "../../lib/format";
import { useReducedMotion } from "../../lib/use-media";
import { Avatar } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { ActivityPopover } from "./activity-popover";

/** Time each ticker line stays up. */
const TICK_MS = 3200;
/** Matches the 380 ms CSS transition (plus a little). */
const SLIDE_MS = 420;

/** Ticker lines: one per working bot (`"Dev: running tests"`), then the approvals line. */
export function tickerItems(bots: BotStatusDto[], approvals: number): string[] {
  const items = bots
    .filter((b) => b.working)
    .map((b) => `${b.name}: ${(b.label || "working").toLowerCase()}`);
  if (approvals > 0) {
    items.push(`${approvals} ${approvals === 1 ? "approval" : "approvals"} waiting for you`);
  }
  return items;
}

interface Line {
  id: number;
  text: string;
  /** `in` waits below, `out` has slid up and fades; empty is the visible line. */
  state: "in" | "out" | "";
}

/**
 * Cycles `items` every 3.2 s. A change of the shown text appends a line in the `in` state; the
 * next frame flips it to visible and the old one to `out`, so CSS slides and blurs between them.
 * With Reduce Motion it still cycles but swaps the text in place (no slide or blur states).
 */
function useTicker(items: string[], reduced: boolean): Line[] {
  const [index, setIndex] = useState(0);
  const target = items.length ? items[index % items.length] : "All quiet";
  const [lines, setLines] = useState<Line[]>([{ id: 0, text: target, state: "" }]);
  const seq = useRef(0);

  useEffect(() => {
    if (items.length < 2) return;
    const t = setInterval(() => setIndex((i) => i + 1), TICK_MS);
    return () => clearInterval(t);
  }, [items.length]);

  useEffect(() => {
    if (reduced) return;
    setLines((cur) =>
      cur[cur.length - 1].text === target
        ? cur
        : [...cur, { id: ++seq.current, text: target, state: "in" }],
    );
  }, [target, reduced]);

  useEffect(() => {
    if (!lines.some((l) => l.state === "in")) return;
    // Two frames: the "in" line must be painted once before its state flips, or no transition runs.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() =>
        setLines((cur) => cur.map((l, i) => ({ ...l, state: i === cur.length - 1 ? "" : "out" }))),
      );
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [lines]);

  useEffect(() => {
    if (!lines.some((l) => l.state === "out")) return;
    const t = setTimeout(() => setLines((cur) => cur.filter((l) => l.state !== "out")), SLIDE_MS);
    return () => clearTimeout(t);
  }, [lines]);

  return reduced ? [{ id: -1, text: target, state: "" }] : lines;
}

/**
 * The toolbar capsule: working faces, a ticker, today's cost and the approvals badge. A click
 * opens the activity popover (Base UI Popover, prototype `.pop` look).
 */
export function ActivityCapsule() {
  const [open, setOpen] = useState(false);
  const { bots } = useDirectory();
  const status = useQuery(orpc.control.status.queryOptions()).data ?? [];
  const approvals = useQuery(orpc.approvals.pending.queryOptions()).data ?? [];
  const lines = useTicker(tickerItems(status, approvals.length), useReducedMotion());
  const avatarOf = (id: string) => bots.get(id)?.avatarUrl;

  // The badge remounts on every count change (key) and bumps for 420 ms; the first paint does not.
  const seen = useRef(approvals.length);
  const [bump, setBump] = useState(false);
  useEffect(() => {
    if (seen.current === approvals.length) return;
    seen.current = approvals.length;
    setBump(true);
    const t = setTimeout(() => setBump(false), SLIDE_MS);
    return () => clearTimeout(t);
  }, [approvals.length]);

  const faces = status.filter((s) => s.working).slice(0, 3);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={open ? "capsule open" : "capsule"} aria-label="Activity">
        <span className="stack">
          {faces.length ? (
            faces.map((f) => (
              <Avatar key={f.botId} src={avatarOf(f.botId)} name={f.name} size={20} working />
            ))
          ) : (
            <Avatar name="Friday" size={20} />
          )}
        </span>
        <span className="cap-text">
          {lines.map((l) => (
            <span key={l.id} className={l.state}>
              {l.text}
            </span>
          ))}
        </span>
        <span className="cap-sep" />
        <span className="cap-cost num">
          {formatCost(status.reduce((sum, s) => sum + s.spendToday, 0))}
        </span>
        {approvals.length > 0 && (
          <Badge key={approvals.length} tone="amber" count={approvals.length} bump={bump} />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="pop-pos" sideOffset={10} align="center">
          <Popover.Popup className="pop">
            <ActivityPopover
              status={status}
              approvals={approvals}
              avatarOf={avatarOf}
              onClose={() => setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

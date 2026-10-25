import type { ScheduleDto } from "@friday/contracts";
import {
  CircleCheck,
  CircleOff,
  type LucideIcon,
  OctagonAlert,
  Pause,
  Play,
  SkipForward,
  TriangleAlert,
} from "lucide-react";
import { Pill } from "../ui/pill";

type Tone = "amber" | "green" | "red" | "blue" | "gray";
type Look = [Tone, LucideIcon, string];

/** Last-run status to pill (prototype `RUN` map). */
const LAST: Record<NonNullable<ScheduleDto["last"]>["status"], Look> = {
  ok: ["green", CircleCheck, "OK"],
  problem: ["amber", TriangleAlert, "Found a problem"],
  failed: ["red", OctagonAlert, "Failed"],
  skipped: ["amber", SkipForward, "Skipped"],
  running: ["blue", Play, "Running"],
};

/** Why the engine turned a schedule off, as the pill says it. */
const REASON: Record<NonNullable<ScheduleDto["disabledReason"]>, Look> = {
  bot_gone: ["gray", CircleOff, "Bot is gone"],
  group_gone: ["gray", CircleOff, "Group is gone"],
  done: ["gray", CircleCheck, "Done"],
};

/** Off by the owner. */
const PAUSED: Look = ["gray", Pause, "Paused"];

/**
 * The row's status pill: the disabled reason or "Paused" when off, else the last run's
 * result. A schedule that is on and has never run shows no pill.
 */
export function ScheduleStatusPill({ schedule: s }: { schedule: ScheduleDto }) {
  const look = s.enabled
    ? s.last && LAST[s.last.status]
    : s.disabledReason
      ? REASON[s.disabledReason]
      : PAUSED;
  return look ? <LookPill look={look} /> : null;
}

/** The pill of one run's status (the schedule page's Recent runs). */
export function RunStatusPill({ status }: { status: keyof typeof LAST }) {
  return <LookPill look={LAST[status]} />;
}

function LookPill({ look: [tone, Icon, label] }: { look: Look }) {
  return (
    <Pill tone={tone}>
      <Icon strokeWidth={2} aria-hidden />
      {label}
    </Pill>
  );
}

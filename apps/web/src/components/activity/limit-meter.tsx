import type { BotStatusDto } from "@friday/contracts";
import { formatCost } from "../../lib/format";
import { limitTone } from "./activity-math";

/** Meter fill per tone (prototype: tint, amber dot; red from the token set). */
const TONE_COLOR = {
  tint: "var(--tint)",
  amber: "var(--amber-dot)",
  red: "var(--red-dot)",
} as const;

/**
 * Limits panel: today's spend of each bot that spent something against the per-bot daily cap.
 * The bar turns amber from 50% and red at 100%.
 */
export function LimitMeter({ bots, capUsd }: { bots: BotStatusDto[]; capUsd: number }) {
  const spent = bots.filter((b) => b.spendToday > 0).sort((a, b) => b.spendToday - a.spendToday);
  return (
    <div className="panel limits">
      {capUsd > 0 &&
        spent.map((b) => {
          const ratio = b.spendToday / capUsd;
          return (
            <div key={b.botId} className="lim-row">
              <div className="lim-h">
                <span>
                  <b>{b.name}</b> <span className="t2">today</span>
                </span>
                <span className="num">
                  {formatCost(b.spendToday)} of {formatCost(capUsd)}
                </span>
              </div>
              <div
                className="meter"
                role="img"
                aria-label={`${b.name} ${Math.round(ratio * 100)}% of the daily limit`}
              >
                <i
                  style={{
                    width: `${Math.min(ratio, 1) * 100}%`,
                    background: TONE_COLOR[limitTone(ratio)],
                  }}
                />
              </div>
            </div>
          );
        })}
      {spent.length === 0 && <div className="lim-row t2">No bot has spent anything today.</div>}
      <div className="lim-note">A bot stops when a limit is reached and asks you to raise it.</div>
    </div>
  );
}

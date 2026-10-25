import { type AuthorDto, MAX_WAKES, type WakeDto } from "@friday/contracts";
import { LoaderCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useDirectory } from "../../api/directory";
import { formatClock, formatDuration } from "../../lib/format";
import { Pill } from "../ui/pill";
import { useSegThumb } from "../ui/use-seg-thumb";
import { wakeBucket, wakeTone } from "./activity-math";

type Filter = "all" | "running" | "failed";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "failed", label: "Failed" },
];

/** All / Running / Failed switch (`.seg`); the thumb sits under the active button. */
function WakeFilter({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const i = FILTERS.findIndex((f) => f.id === value);
  const box = useRef<HTMLSpanElement>(null);
  const thumb = useSegThumb(box, i, FILTERS.length, "");
  return (
    <span ref={box} className="seg">
      <span className="thumb" style={thumb} />
      {FILTERS.map((f) => (
        <button
          type="button"
          key={f.id}
          className={f.id === value ? "on" : ""}
          onClick={() => onChange(f.id)}
        >
          {f.label}
        </button>
      ))}
    </span>
  );
}

/**
 * The Wakes section: heading with the All / Running / Failed switch (filtered here, client side)
 * over the table. A full page from the server says "Latest 200": older wakes in the window are cut.
 */
export function WakesTable({ wakes, now }: { wakes: WakeDto[]; now: number }) {
  const dir = useDirectory();
  const [active, setActive] = useState<Filter>("all");
  const rows = wakes.filter((w) => active === "all" || wakeBucket(w.status) === active);
  const who = (a: AuthorDto) =>
    a.kind === "bot" ? dir.botName(a.botId) : a.kind === "user" ? "You" : "System";
  return (
    <>
      <h2>
        Wakes
        <span className="aside">
          {wakes.length >= MAX_WAKES && <span style={{ marginRight: 10 }}>Latest {MAX_WAKES}</span>}
          <WakeFilter value={active} onChange={setActive} />
        </span>
      </h2>
      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>Wake</th>
              <th>From → to</th>
              <th>Intent</th>
              <th>Status</th>
              <th className="r">Started</th>
              <th className="r">Took</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id}>
                <td className="mono" style={{ color: "var(--label-2)" }}>
                  {w.id}
                </td>
                <td>
                  {who(w.sender)} <span style={{ color: "var(--label-3)" }}>→</span>{" "}
                  {dir.botName(w.targetBot)}
                </td>
                <td>{w.intent}</td>
                <td>
                  <Pill tone={wakeTone(w.status)}>
                    {wakeBucket(w.status) === "running" && (
                      <LoaderCircle size={12} className="spin" />
                    )}
                    {w.status}
                  </Pill>
                </td>
                <td className="r num" style={{ color: "var(--label-2)" }}>
                  {formatClock(w.startedAt ?? w.createdAt, now)}
                </td>
                <td className="r num">
                  {w.startedAt !== undefined && w.endedAt !== undefined
                    ? formatDuration(w.endedAt - w.startedAt)
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

import { useMemo } from "react";
import { Row } from "../settings/form-parts";
import { TicketSelect } from "../tickets/ticket-select";
import type { ScheduleFormProps } from "./schedule-form";
import { timeZones } from "./schedule-form-state";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first; the value is the rule's weekday (0 Sunday). */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
/** Select value of "the owner zone" (the form keeps it as an empty string). */
const OWNER_ZONE = "owner";

/**
 * The At (or Every) row: the time, the weekday of Weekly, the date of Once, or the length and
 * unit of Interval; then the time zone, a picker on create and plain text after (it never
 * changes). One error line: the refused field's.
 */
export function ScheduleWhenRow({ value: v, set, errors, mode, readOnly }: ScheduleFormProps) {
  const create = mode === "create";
  const zones = useMemo(() => (create ? timeZones() : []), [create]);
  const interval = v.repeat === "interval";
  // Only the refusal of a field the current Repeat uses.
  const error = interval
    ? errors.every
    : (errors.at ?? (v.repeat === "once" ? errors.date : undefined));
  const cls = (bad?: string) => (bad ? "field num err" : "field num");

  return (
    <Row label={interval ? "Every" : "At"} htmlFor={interval ? "sc-every" : "sc-at"} error={error}>
      <div className="sched-when">
        {interval ? (
          <>
            <input
              id="sc-every"
              className={cls(errors.every)}
              inputMode="numeric"
              value={v.every}
              disabled={readOnly}
              onChange={(e) => set("every", e.target.value)}
            />
            <TicketSelect
              label="Unit"
              value={v.unit}
              options={[
                { value: "minutes", node: "minutes" },
                { value: "hours", node: "hours" },
              ]}
              current={v.unit}
              disabled={readOnly}
              onChange={(u) => {
                set("unit", u);
                set("every", v.every); // the old unit's refusal no longer applies
              }}
            />
          </>
        ) : (
          <>
            {v.repeat === "once" && (
              <input
                type="date"
                aria-label="Date"
                className={cls(errors.date)}
                value={v.date}
                disabled={readOnly}
                onChange={(e) => set("date", e.target.value)}
              />
            )}
            <input
              id="sc-at"
              className={cls(errors.at)}
              placeholder="HH:MM"
              inputMode="numeric"
              value={v.at}
              disabled={readOnly}
              onChange={(e) => set("at", e.target.value)}
            />
            {v.repeat === "weekly" && (
              <TicketSelect
                label="Weekday"
                value={String(v.weekday)}
                options={WEEK_ORDER.map((d) => ({ value: String(d), node: WEEKDAYS[d] }))}
                current={WEEKDAYS[v.weekday]}
                disabled={readOnly}
                onChange={(d) => set("weekday", Number(d))}
              />
            )}
          </>
        )}
        {create ? (
          <TicketSelect
            label="Time zone"
            value={v.timeZone || OWNER_ZONE}
            options={[OWNER_ZONE, ...zones].map((z) => ({
              value: z,
              node: z === OWNER_ZONE ? "Owner zone" : z,
            }))}
            current={v.timeZone || "Owner zone"}
            onChange={(z) => set("timeZone", z === OWNER_ZONE ? "" : z)}
            popupClassName="sched-zone-pop"
          />
        ) : (
          <span className="t2">{v.timeZone}</span>
        )}
      </div>
    </Row>
  );
}

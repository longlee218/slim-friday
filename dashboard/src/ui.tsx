import type { CSSProperties, ReactNode } from "react";

/**
 * Role -> categorical slot, fixed so a role keeps its color on every screen and in every window.
 * Seven slots of the validated order; every other role shares the neutral "other".
 */
const ROLE_SLOT: Record<string, string> = {
  lead: "--s1",
  developer: "--s2",
  tester: "--s3",
  scout: "--s4",
  designer: "--s5",
  researcher: "--s6",
  planner: "--s7",
};
export const NAMED_ROLES = Object.keys(ROLE_SLOT);
export function roleColor(role: string): string {
  return `var(${ROLE_SLOT[role] ?? "--s-other"})`;
}
/** Chart key of a role: named roles keep their own, the rest fold into "other". */
export function roleKey(role: string): string {
  return ROLE_SLOT[role] ? role : "other";
}

export function Role({ role }: { role: string }) {
  return (
    <span className="role" style={{ "--rc": roleColor(role) } as CSSProperties}>
      <i />
      {role}
    </span>
  );
}

/** Every status word in the db mapped to one of five looks. */
const STATUS_TONE: Record<string, string> = {
  completed: "ok",
  done: "ok",
  success: "ok",
  running: "run",
  open: "run",
  blocked: "bad",
  failed: "bad",
  aborted: "bad",
  max_turns: "warn",
  interrupted: "warn",
  cancelled: "idle",
  pending: "idle",
};

export function Status({ value }: { value: string | null }) {
  const v = value ?? "unknown";
  return (
    <span className={`status ${STATUS_TONE[v] ?? "idle"}`}>
      <i />
      {v.replace("_", " ")}
    </span>
  );
}

/** One square per item, colored by status: a goal's progress at a glance. */
export function ItemSquares({ statuses }: { statuses: string[] }) {
  return (
    <span className="progress" aria-label={statuses.join(", ")}>
      {statuses.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: order is the item order
        <i key={i} className={s} title={s} />
      ))}
    </span>
  );
}

/** Magnitude bar inside a table cell; `value` is 0..1 of the column max. */
export function Share({ value, label, color }: { value: number; label: string; color?: string }) {
  return (
    <span className="share" style={color ? ({ "--rc": color } as CSSProperties) : undefined}>
      <b>
        <i style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </b>
      <span>{label}</span>
    </span>
  );
}

export function Section({
  title,
  note,
  right,
  children,
}: {
  title: string;
  note?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <header>
        <h2>{title}</h2>
        {note && <span className="muted">{note}</span>}
        {right && <span className="right">{right}</span>}
      </header>
      {children}
    </section>
  );
}

export function Stats({ items }: { items: [string, ReactNode, boolean?][] }) {
  return (
    <dl className="stats">
      {items.map(([label, value, bad]) => (
        <div className="stat" key={label}>
          <dt>{label}</dt>
          <dd className={bad ? "bad" : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Underlined tabs: switch views of one object without leaving the page. */
export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} onClick={() => onChange(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Loading / error / empty wrapper; a refresh keeps the old frame, dimmed, instead of a skeleton. */
export function Load<T>({
  state,
  empty,
  isEmpty,
  children,
}: {
  state: { data: T | null; error: string | null; loading: boolean };
  empty?: string;
  isEmpty?: (d: T) => boolean;
  children: (d: T) => ReactNode;
}) {
  if (state.error && !state.data) return <div className="error">{state.error}</div>;
  if (!state.data) return <div className="skeleton" />;
  if (isEmpty?.(state.data)) return <div className="empty">{empty ?? "Nothing in this window."}</div>;
  return <div className={state.loading ? "load refreshing" : "load"}>{children(state.data)}</div>;
}

/** 16px stroke icons, one weight, drawn here so the set stays consistent. */
const ICONS: Record<string, ReactNode> = {
  goals: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  threads: <path d="M3 4h10v6.5H7.5L4.5 13v-2.5H3z" />,
  cost: <path d="M2.5 13.5h11M4.5 13.5V9M8 13.5V5M11.5 13.5V7.5" />,
  problems: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2" />,
  skills: <path d="M8 2 9.6 6.2 14 6.6 10.6 9.4 11.7 13.8 8 11.4 4.3 13.8 5.4 9.4 2 6.6 6.4 6.2z" />,
  prompts: <path d="M3 3.5h10v9H3zM5.5 6.5 7.5 8l-2 1.5M9 9.5h2" />,
  search: <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6 14 14" />,
  warn: <path d="M8 2.5 14 13H2zM8 6.5v3M8 11.3v.2" />,
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  back: <path d="M10 3.5 5.5 8l4.5 4.5" />,
};
export function Icon({ name, size = 16 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

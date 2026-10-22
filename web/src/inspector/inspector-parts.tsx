import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { Icon } from "../ui/icon";

/** Inset grouped list section (macOS settings style). */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="inset">
      <h3>{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}

interface MeterProps {
  label: string;
  value: number;
  max: number;
  format(v: number): string;
  /** Show only the value (percent meters), not "value of max". */
  valueOnly?: boolean;
}

export function Meter({ label, value, max, format, valueOnly }: MeterProps) {
  return (
    <li className="inset__meter">
      <span className="inset__row">
        <span>{label}</span>
        <span className="inset__value">{valueOnly ? format(value) : `${format(value)} of ${format(max)}`}</span>
      </span>
      <span className="meter" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <i style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
      </span>
    </li>
  );
}

/** List row that opens a sub-page: leading content, optional value, chevron. */
export function NavRow({ children, value, onOpen }: { children: ReactNode; value?: string; onOpen(): void }) {
  return (
    <li className="inset__nav">
      <button type="button" onClick={onOpen}>
        {children}
        {value && <span className="inset__value">{value}</span>}
        <span className="inset__chev" aria-hidden="true">
          <Icon name="next" size={12} />
        </span>
      </button>
    </li>
  );
}

/** List row that runs an action (rename, delete); `hint` says why it is disabled. */
export function ActionRow(props: { label: string; onClick(): void; danger?: boolean; disabled?: boolean; hint?: string }) {
  return (
    <li className="inset__nav">
      <button type="button" onClick={props.onClick} data-danger={props.danger || undefined} disabled={props.disabled}>
        <span className="inset__main">
          {props.label}
          {props.hint && <small>{props.hint}</small>}
        </span>
      </button>
    </li>
  );
}

/** Sub-page header: back to the details list, title, optional action on the right. */
export function PageHeader({ title, onBack, action }: { title: string; onBack?(): void; action?: ReactNode }) {
  return (
    <div className="page-head">
      {onBack ? (
        <button type="button" className="tool" onClick={onBack} aria-label="Back to details">
          <Icon name="back" />
        </button>
      ) : (
        <span className="page-head__gap" />
      )}
      <h2>{title}</h2>
      <span className="page-head__action">{action}</span>
    </div>
  );
}

/** Markdown from memory and instructions; raw HTML is never rendered. */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  );
}

import type { ReactNode } from "react";
import { Button } from "../ui/button";

/** One `.frow`: label, control and an optional help line (red when `error` is set). */
export function Row({
  label,
  htmlFor,
  top,
  help,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** Align to the top (for token lists and tall controls). */
  top?: boolean;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className={top ? "frow top" : "frow"}>
      <label htmlFor={htmlFor}>{label}</label>
      <div>
        {children}
        {error ? (
          <div className="help err">{error}</div>
        ) : (
          help && <div className="help">{help}</div>
        )}
      </div>
    </div>
  );
}

/** Segmented control (`.seg`); the thumb sits under the chosen option, none when nothing is chosen. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: readonly T[];
  value: T | undefined;
  onChange(v: T): void;
  disabled?: boolean;
}) {
  const at = value ? options.indexOf(value) : -1;
  const width = `calc((100% - 4px) / ${options.length})`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add its own border and padding
    <div className="seg" style={{ display: "flex" }} role="group" aria-label={label}>
      {at >= 0 && (
        <span className="thumb" style={{ left: `calc(2px + ${at} * ${width})`, width }} />
      )}
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={o === value ? "on" : ""}
          aria-pressed={o === value}
          style={{ flex: "1 1 0" }}
          disabled={disabled}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** The `.switch` toggle. */
export function Switch({
  label,
  on,
  onChange,
  disabled,
}: {
  label: string;
  on: boolean;
  onChange(on: boolean): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={on ? "switch on" : "switch"}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

/** Revert and Save at the bottom of a form; both stay disabled until something changed. */
export function SaveBar({
  dirty,
  valid,
  saving,
  onRevert,
  onSave,
}: {
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  onRevert(): void;
  onSave(): void;
}) {
  return (
    <div className="savebar">
      <Button disabled={!dirty || saving} onClick={onRevert}>
        Revert
      </Button>
      <Button variant="primary" disabled={!dirty || !valid || saving} onClick={onSave}>
        Save
      </Button>
    </div>
  );
}

/** Shown in a form whose server value changed while the owner has unsaved edits. */
export function StaleNotice({ what }: { what: "bot" | "group" | "server" }) {
  return (
    <div className="foot-note" role="status">
      This {what} changed elsewhere. Revert to load the latest, or save to overwrite it.
    </div>
  );
}

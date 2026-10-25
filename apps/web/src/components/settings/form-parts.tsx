import { type ReactNode, useRef } from "react";
import { Button } from "../ui/button";
import { useSegThumb } from "../ui/use-seg-thumb";

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

/**
 * Layout of a `.seg` that fills its row: one column per option, each as wide as its label plus an
 * equal share of the rest, labels centred. The thumb is measured (`useSegThumb`), so unequal
 * columns still line up.
 */
export const SEG_GRID = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "auto",
} as const;
export const SEG_BUTTON = { justifyContent: "center" } as const;

/**
 * Segmented control (`.seg`); the thumb sits under the chosen option, none when nothing is chosen.
 * Default: columns that fill the row. `fit`: each option only as wide as its label (a filter bar).
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  names,
  fit,
}: {
  label: string;
  options: readonly T[];
  value: T | undefined;
  onChange(v: T): void;
  disabled?: boolean;
  /** Shown text per option; the option value when absent. */
  names?: Partial<Record<T, string>>;
  fit?: boolean;
}) {
  const at = value ? options.indexOf(value) : -1;
  const box = useRef<HTMLDivElement>(null);
  const labels = options.map((o) => names?.[o] ?? o).join("\n");
  const thumb = useSegThumb(box, at, options.length, labels);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add its own border and padding
    <div
      ref={box}
      className="seg"
      style={fit ? undefined : SEG_GRID}
      role="group"
      aria-label={label}
    >
      {at >= 0 && <span className="thumb" style={thumb} />}
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={o === value ? "on" : ""}
          aria-pressed={o === value}
          style={SEG_BUTTON}
          disabled={disabled}
          onClick={() => onChange(o)}
        >
          {names?.[o] ?? o}
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
export function StaleNotice({ what }: { what: "bot" | "group" | "server" | "schedule" }) {
  return (
    <div className="foot-note" role="status">
      This {what} changed elsewhere. Revert to load the latest, or save to overwrite it.
    </div>
  );
}

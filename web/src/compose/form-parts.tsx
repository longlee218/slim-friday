import { motion } from "motion/react";
import type { ReactNode } from "react";
import { SPRING_SNAPPY } from "../ui/motion-presets";

/** Labeled form field with an optional hint or error under it. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="field" data-invalid={error ? true : undefined}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {(error || hint) && <span className="field__hint">{error ?? hint}</span>}
    </div>
  );
}

/**
 * Segmented control (macOS style): native radios, a pill that slides to the choice.
 * `id` keeps the pill animation separate per control.
 */
export function Segmented<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange(v: T): void;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.value} className="seg__opt" data-on={o.value === value || undefined}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg__pill" transition={SPRING_SNAPPY} />}
          <input
            type="radio"
            className="sr-only"
            name={`seg-${id}`}
            checked={o.value === value}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

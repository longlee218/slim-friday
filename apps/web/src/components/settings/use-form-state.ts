import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { saveFailure } from "./field-error";

/** Error text per field of a form value. */
export type FieldErrors<T> = Partial<Record<keyof T, string>>;

/** What `useFormState` returns. */
export interface FormState<T> {
  value: T;
  set<K extends keyof T>(k: K, v: T[K]): void;
  /** True when `value` differs from the last saved (or initial) value. */
  dirty: boolean;
  /** Puts the saved value back and clears every error. */
  revert(): void;
  /** Validator errors of the fields the owner changed, then the server's per-field errors. */
  errors: FieldErrors<T>;
  /** False while the validator reports an error (even for a field not touched yet). */
  valid: boolean;
  /**
   * Runs `fn(value)`. Success makes the value the new saved one. A `BAD_REQUEST` with
   * `data.field` marks that field; any other error is a toast.
   */
  submit(fn: (v: T) => Promise<unknown>): Promise<void>;
  saving: boolean;
}

/**
 * State of one settings form. `validate` (optional) is the contract's zod schema turned into
 * field messages; its errors show only for fields the owner has changed, so a new empty form
 * does not open in red.
 */
export function useFormState<T extends object>(
  initial: T,
  validate?: (v: T) => FieldErrors<T>,
): FormState<T> {
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState<ReadonlySet<keyof T>>(new Set());
  const [server, setServer] = useState<FieldErrors<T>>({});
  const [saving, setSaving] = useState(false);
  // The latest value, read by `submit` so a call made right after `set` sees it.
  const latest = useRef(value);
  latest.current = value;

  const set = useCallback(<K extends keyof T>(k: K, v: T[K]) => {
    setValue((x) => ({ ...x, [k]: v }));
    setTouched((s) => new Set(s).add(k));
    setServer(({ [k]: _gone, ...rest }) => rest as FieldErrors<T>);
  }, []);

  const revert = useCallback(() => {
    setValue(saved);
    setTouched(new Set());
    setServer({});
  }, [saved]);

  const submit = useCallback(async (fn: (v: T) => Promise<unknown>) => {
    const sent = latest.current;
    setSaving(true);
    try {
      await fn(sent);
      setSaved(sent);
      setTouched(new Set());
      setServer({});
    } catch (e) {
      const { message, field } = saveFailure(e);
      if (field) setServer({ [field]: message } as FieldErrors<T>);
      else toast.error(message);
    } finally {
      setSaving(false);
    }
  }, []);

  const found = useMemo(() => validate?.(value) ?? {}, [validate, value]);
  const errors = useMemo(() => {
    const shown: FieldErrors<T> = {};
    for (const k of Object.keys(found) as (keyof T)[]) if (touched.has(k)) shown[k] = found[k];
    return { ...shown, ...server };
  }, [found, touched, server]);

  return {
    value,
    set,
    dirty: JSON.stringify(value) !== JSON.stringify(saved),
    revert,
    errors,
    valid: Object.keys(found).length === 0,
    submit,
    saving,
  };
}

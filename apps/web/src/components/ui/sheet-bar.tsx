import type { FormEvent, ReactNode } from "react";

export interface SheetBarProps {
  title: string;
  onCancel(): void;
  /** The sheet's main action (a `.nb strong` button), right of the title. */
  action: ReactNode;
}

/** iOS sheet header: Cancel on the left, the centred title, the main action on the right. */
export function SheetBar({ title, onCancel, action }: SheetBarProps) {
  return (
    <div className="bs-bar">
      <button type="button" className="nb" onClick={onCancel}>
        Cancel
      </button>
      <h3>{title}</h3>
      <div className="bs-bar-r">{action}</div>
    </div>
  );
}

/**
 * A form sheet on the phone: the bar stays put and the fields scroll in `.bs-body` (see
 * BottomSheet). Submitting (Enter or a submit `action`) calls `onSubmit` with the default
 * prevented.
 */
export function PhoneSheetForm({
  onSubmit,
  children,
  ...bar
}: SheetBarProps & { onSubmit(): void; children: ReactNode }) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form className="bs-form" onSubmit={submit}>
      <SheetBar {...bar} />
      <div className="bs-body">{children}</div>
    </form>
  );
}

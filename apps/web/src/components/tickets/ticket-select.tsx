import { Select } from "@base-ui/react/select";
import { ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";

export interface TicketSelectOption<T extends string> {
  value: T;
  /** Row content in the menu (and, through `current`, in the button). */
  node: ReactNode;
}

export interface TicketSelectProps<T extends string> {
  /** Accessible name of the button, e.g. "Status". */
  label: string;
  value: T | null;
  options: TicketSelectOption<T>[];
  /** What the button shows (the chosen option, or "Unassigned"). */
  current: ReactNode;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Extra class of the popup (e.g. a scroll limit for a long list). */
  popupClassName?: string;
}

/**
 * Prototype `.popbtn` that opens a Base UI `Select` menu (`.pop` look). The button shows
 * `current`; choosing a row calls `onChange` once, picking the shown value does nothing.
 */
export function TicketSelect<T extends string>({
  label,
  value,
  options,
  current,
  onChange,
  disabled,
  popupClassName,
}: TicketSelectProps<T>) {
  return (
    <Select.Root
      value={value}
      disabled={disabled}
      onValueChange={(v) => {
        if (v && v !== value) onChange(v as T);
      }}
    >
      <Select.Trigger className="popbtn" aria-label={label}>
        {current}
        <ChevronsUpDown strokeWidth={1.75} />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="pop-pos" sideOffset={6} alignItemWithTrigger={false}>
          <Select.Popup
            className={popupClassName ? `pop sel-pop ${popupClassName}` : "pop sel-pop"}
          >
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="sel-it">
                <Select.ItemText>{o.node}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

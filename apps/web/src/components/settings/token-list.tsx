import { Combobox } from "@base-ui/react/combobox";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../ui/button";

export interface TokenListProps {
  values: string[];
  /** Names the owner may add; a typed value that is not here is offered as a custom entry. */
  options: string[];
  onChange(values: string[]): void;
  /** Text of the add button, e.g. "Add tool". */
  addLabel: string;
  /** Mono tokens are the default; group members and names use the plain font. */
  plain?: boolean;
  /** Read only (shipped bots): tokens without remove buttons and no add button. */
  disabled?: boolean;
  /** Turns a stored value into its label (a bot id into its name). */
  label?: (value: string) => string;
}

/**
 * The prototype's `.toks` row: a token per value with a remove button, then an "add" token
 * that opens a Base UI `Combobox` (type to filter, Enter or click to add).
 */
export function TokenList({
  values,
  options,
  onChange,
  addLabel,
  plain,
  disabled,
  label = (v) => v,
}: TokenListProps) {
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const free = options.filter((o) => !values.includes(o));
  const text = typed.trim();
  const custom = text && !free.includes(text) && !values.includes(text) ? [text] : [];
  const items = [...free, ...custom];

  return (
    <div className="toks">
      {values.map((v) => (
        <span key={v} className="tok" style={plain ? { fontFamily: "var(--font)" } : undefined}>
          {label(v)}
          {!disabled && (
            <IconButton
              label={`Remove ${label(v)}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <X size={12} strokeWidth={1.75} />
            </IconButton>
          )}
        </span>
      ))}
      {!disabled && (
        <Combobox.Root
          items={items}
          value={null}
          open={open}
          onOpenChange={setOpen}
          inputValue={typed}
          onInputValueChange={setTyped}
          onValueChange={(v) => {
            if (typeof v === "string") onChange([...values, v]);
            setTyped("");
            setOpen(false);
          }}
        >
          <Combobox.Trigger className="tok add">
            <Plus size={12} strokeWidth={1.75} /> {addLabel}
          </Combobox.Trigger>
          <Combobox.Portal>
            <Combobox.Positioner className="pop-pos" sideOffset={6}>
              <Combobox.Popup className="pop sel-pop">
                <Combobox.Input
                  className="field"
                  aria-label={addLabel}
                  placeholder="Type to search"
                />
                <Combobox.Empty className="sel-it">Nothing to add.</Combobox.Empty>
                <Combobox.List>
                  {(item: string) => (
                    <Combobox.Item key={item} value={item} className="sel-it">
                      {label(item)}
                    </Combobox.Item>
                  )}
                </Combobox.List>
              </Combobox.Popup>
            </Combobox.Positioner>
          </Combobox.Portal>
        </Combobox.Root>
      )}
    </div>
  );
}

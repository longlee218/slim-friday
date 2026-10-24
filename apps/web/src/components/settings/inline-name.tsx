import { Pencil } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { IconButton } from "../ui/button";
import { saveFailure } from "./field-error";

/** A bot's name is 1 to 32 characters (the bot id limit). */
const MAX_NAME = 32;
const HELP = `Use 1 to ${MAX_NAME} characters.`;

export interface InlineNameProps {
  value: string;
  /** Saves the new (trimmed) name; a rejection keeps the editor open with the message. */
  onSave(name: string): Promise<void>;
  /** Shipped bots cannot be renamed. */
  disabled?: boolean;
}

/**
 * The page title that renames in place (prototype `.name-edit`): click it or the pencil, Enter
 * saves, Esc cancels. An empty or too long name, or a refused save, shakes the field and shows
 * the reason; a save toasts that mentions use the new name.
 */
export function InlineName({ value, onSave, disabled }: InlineNameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [problem, setProblem] = useState<string | null>(null);
  const [shaking, setShaking] = useState(false);
  const busy = useRef(false);

  const open = () => {
    setDraft(value);
    setProblem(null);
    setEditing(true);
  };
  const refuse = (message: string) => {
    setProblem(message);
    setShaking(true);
  };

  const commit = async () => {
    const name = draft.trim();
    if (name.length < 1 || name.length > MAX_NAME) return refuse(HELP);
    if (name === value) return setEditing(false);
    if (busy.current) return;
    busy.current = true;
    try {
      await onSave(name);
      setEditing(false);
      toast(`Mentions use @${name} now`);
    } catch (e) {
      const { message } = saveFailure(e);
      refuse(message);
    } finally {
      busy.current = false;
    }
  };

  if (!editing) {
    return (
      <div className="name-edit">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the pencil button is the keyboard path */}
        <h2 title="Click to rename" onClick={disabled ? undefined : open}>
          {value}
        </h2>
        {!disabled && (
          <IconButton label="Rename" onClick={open}>
            <Pencil size={14} strokeWidth={1.75} />
          </IconButton>
        )}
      </div>
    );
  }
  return (
    <div>
      <div className="name-edit">
        <input
          className={["field", problem && "err", shaking && "shake"].filter(Boolean).join(" ")}
          onAnimationEnd={() => setShaking(false)}
          aria-label="Name"
          // biome-ignore lint/a11y/noAutofocus: the owner just asked to rename
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            else if (e.key === "Enter") void commit();
          }}
        />
      </div>
      {problem && <div className="help err">{problem}</div>}
    </div>
  );
}

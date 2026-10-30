import { Pencil, Trash2 } from "lucide-react";
import { type CSSProperties, type ReactNode, type Ref, useRef, useState } from "react";
import { IconButton } from "../ui/button";

export interface NoteRowProps {
  text: string;
  /** Noun in the button names: "note" gives "Edit note" and "Delete note". */
  noun: string;
  /** Longest text the edit field takes. */
  maxLength?: number;
  /** Extra classes on the row (`rule`, `off`, `dragging`). */
  className?: string;
  /** Attribute on the row so a test or the sorter can find it. */
  dataKey?: string;
  rowRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  /** Before the text (the rule's grip). */
  lead?: ReactNode;
  /** Under the text (the note's kind pill and age). */
  meta?: ReactNode;
  /** After the buttons (the rule's switch). */
  trail?: ReactNode;
  /** Resolve `false` to say the save failed: the row then stays in edit mode with the draft. */
  onEdit(text: string): unknown; // a Promise<false> keeps the draft open
  onDelete(): void;
}

/**
 * The prototype's `.note` row: text, optional meta line, and edit and delete buttons that show on
 * hover. Edit swaps the text for a field: Enter saves a changed non-empty text, Escape or blur cancels.
 */
export function NoteRow(p: NoteRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  // True while a save is in flight: a blur then must not drop the draft a failed save would keep.
  const saving = useRef(false);
  const commit = async () => {
    const text = (draft ?? "").trim();
    if (!text || text === p.text) return setDraft(null);
    setDraft(text);
    saving.current = true;
    const ok = (await p.onEdit(text)) !== false;
    saving.current = false;
    // A failed save (`false`) keeps the owner's text in the field; anything else closes it.
    if (ok) setDraft(null);
  };
  return (
    <div
      ref={p.rowRef}
      style={p.style}
      className={`note ${p.className ?? ""}`}
      data-rule={p.dataKey}
    >
      {p.lead}
      <div className="grow">
        {draft === null ? (
          <div className="nt">{p.text}</div>
        ) : (
          <input
            className="field"
            style={{ width: "100%" }}
            value={draft}
            maxLength={p.maxLength}
            // biome-ignore lint/a11y/noAutofocus: the owner just pressed Edit
            autoFocus
            aria-label={`Edit ${p.noun}`}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => !saving.current && setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commit();
              if (e.key === "Escape") setDraft(null);
            }}
          />
        )}
        {p.meta}
      </div>
      <div className="acts">
        <IconButton label={`Edit ${p.noun}`} onClick={() => setDraft(p.text)}>
          <Pencil size={14} strokeWidth={1.75} />
        </IconButton>
        <IconButton label={`Delete ${p.noun}`} onClick={p.onDelete}>
          <Trash2 size={14} strokeWidth={1.75} />
        </IconButton>
      </div>
      {p.trail}
    </div>
  );
}

import type { MemoryKind } from "@friday/contracts";
import { toast } from "sonner";
import { Button } from "../ui/button";

/**
 * Shown when an edit hit a CONFLICT: the note changed (or went) since the list loaded, so its row
 * may be gone. Holds the owner's typed text as plain text so it is never lost; the owner can copy
 * it, add it as a new note of the edited note's `kind` (named in the banner), or dismiss it.
 */
export function LostNoteBanner(p: {
  text: string;
  kind: MemoryKind;
  onAdd(): void;
  onDismiss(): void;
}) {
  const copy = () =>
    navigator.clipboard?.writeText(p.text).then(
      () => toast.success("Copied."),
      () => toast.error("Could not copy."),
    );
  return (
    <div className="note" role="alert">
      <div className="grow">
        <div className="nt">This {p.kind} note changed. Your text:</div>
        <div className="nt">{p.text}</div>
      </div>
      <Button onClick={() => void copy()}>Copy</Button>
      <Button variant="primary" onClick={p.onAdd}>
        Add as new note
      </Button>
      <Button onClick={p.onDismiss}>Dismiss</Button>
    </div>
  );
}

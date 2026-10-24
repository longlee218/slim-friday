import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useState } from "react";
import { IconButton } from "../../ui/button";
import type { Pair } from "./mcp-spec";

/** One row: a name, a value masked until the eye is pressed, and a remove button. */
function KvRow({
  what,
  pair,
  disabled,
  onChange,
  onRemove,
}: {
  what: string;
  pair: Pair;
  disabled?: boolean;
  onChange(p: Pair): void;
  onRemove(): void;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="kvrow">
      <input
        className="field mono"
        aria-label={`${what} name`}
        value={pair.k}
        disabled={disabled}
        onChange={(e) => onChange({ ...pair, k: e.target.value })}
      />
      <input
        className="field mono"
        aria-label={`${what} value`}
        type={shown ? "text" : "password"}
        placeholder="${NAME}"
        value={pair.v}
        disabled={disabled}
        onChange={(e) => onChange({ ...pair, v: e.target.value })}
      />
      <IconButton label={shown ? "Hide value" : "Show value"} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
      </IconButton>
      {!disabled && (
        <IconButton label={`Remove ${what.toLowerCase()}`} onClick={onRemove}>
          <X size={14} strokeWidth={1.75} />
        </IconButton>
      )}
    </div>
  );
}

/** The rows of an environment or header list, with the "Add" token (hidden when read only). */
export function KvRows({
  what,
  rows,
  disabled,
  onChange,
}: {
  /** "Variable" or "Header". */
  what: string;
  rows: Pair[];
  disabled?: boolean;
  onChange(rows: Pair[]): void;
}) {
  return (
    <div>
      {rows.map((p, i) => (
        <KvRow
          // Rows have no id and may repeat a name while typing, so the position is the key.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={i}
          what={what}
          pair={p}
          disabled={disabled}
          onChange={(x) => onChange(rows.map((r, j) => (j === i ? x : r)))}
          onRemove={() => onChange(rows.filter((_, j) => j !== i))}
        />
      ))}
      {!disabled && (
        <button
          type="button"
          className="tok add"
          onClick={() => onChange([...rows, { k: "", v: "" }])}
        >
          <Plus size={12} strokeWidth={1.75} /> Add {what.toLowerCase()}
        </button>
      )}
    </div>
  );
}

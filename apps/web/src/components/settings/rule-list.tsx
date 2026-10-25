import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MAX_RULE_CHARS, MAX_RULES, type MemoryOwner, type RuleDto } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GripVertical } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { Button } from "../ui/button";
import { Switch } from "./form-parts";
import { NoteRow } from "./note-row";
import { useOwnerName } from "./prompt-meter";

/** One rule row: a grip that drags (pointer or keyboard), the text, edit, delete and its switch. */
function SortableRule({
  id,
  rule,
  onChange,
  onDelete,
}: {
  id: string;
  rule: RuleDto;
  onChange(rule: RuleDto): void;
  onDelete(): void;
}) {
  const s = useSortable({ id });
  return (
    <NoteRow
      noun="rule"
      text={rule.text}
      maxLength={MAX_RULE_CHARS}
      dataKey={id}
      rowRef={s.setNodeRef}
      style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition }}
      className={`rule ${rule.on ? "" : "off"} ${s.isDragging ? "dragging" : ""}`}
      lead={
        <button
          type="button"
          className="drag ib"
          ref={s.setActivatorNodeRef}
          {...s.attributes}
          {...s.listeners}
          aria-label="Reorder rule"
        >
          <GripVertical size={14} strokeWidth={1.75} />
        </button>
      }
      trail={<Switch label="Rule on" on={rule.on} onChange={(on) => onChange({ ...rule, on })} />}
      onEdit={(text) => onChange({ ...rule, text })}
      onDelete={onDelete}
    />
  );
}

/**
 * The rules of a bot or group (`RULES.md`): drag to reorder (the order is the prompt order), switch
 * on or off, edit, delete, add. Every change saves the whole list. The list updates at once and
 * goes back to the last saved copy, with a toast, when the save is refused.
 */
export function RuleList({ owner }: { owner: MemoryOwner }) {
  const qc = useQueryClient();
  const name = useOwnerName(owner);
  const key = orpc.memory.rules.get.queryKey({ input: { owner } });
  const rules = useQuery(orpc.memory.rules.get.queryOptions({ input: { owner } })).data ?? [];
  const [text, setText] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  /** Shows `next` now, saves it, and restores the previous list if the save fails. */
  const commit = async (next: RuleDto[]) => {
    const prev = qc.getQueryData(key);
    qc.setQueryData(key, next);
    try {
      await client.memory.rules.save({ owner, rules: next });
    } catch (e) {
      qc.setQueryData(key, prev);
      toast.error(e instanceof Error ? e.message : "Could not save the rules.");
    }
  };
  /** The newest list (a save may be in flight), so two quick changes never overwrite each other. */
  const current = () => qc.getQueryData(key) ?? rules;
  const ids = rules.map((_, i) => String(i));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) {
      void commit(
        arrayMove(current(), ids.indexOf(String(active.id)), ids.indexOf(String(over.id))),
      );
    }
  };
  const full = rules.length >= MAX_RULES;
  const add = () => {
    const t = text.trim();
    if (!t || full) return;
    setText("");
    void commit([...current(), { text: t, on: true }]);
  };
  return (
    <>
      <div className="foot-note" style={{ margin: "0 0 12px" }}>
        Rules are always in {name}'s prompt, before memory. Keep them short; {name} follows them in
        every chat and group.
      </div>
      <div className="list-panel">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {rules.map((rule, i) => (
              <SortableRule
                // biome-ignore lint/suspicious/noArrayIndexKey: a rule has no id; its place is its id
                key={i}
                id={String(i)}
                rule={rule}
                onChange={(r) => void commit(current().map((x, j) => (j === i ? r : x)))}
                onDelete={() => void commit(current().filter((_, j) => j !== i))}
              />
            ))}
          </SortableContext>
        </DndContext>
        <div className="add-row">
          <input
            className="field"
            maxLength={MAX_RULE_CHARS}
            placeholder="Add a rule, e.g. “Ask before deleting files.”"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <Button variant="primary" disabled={!text.trim() || full} onClick={add}>
            Add rule
          </Button>
        </div>
      </div>
      {full && <div className="foot-note">At most {MAX_RULES} rules.</div>}
    </>
  );
}

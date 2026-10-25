import type { MemoryKind, MemoryOwner } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { client, orpc } from "../../api/client";
import { formatAge } from "../../lib/format";
import { Button } from "../ui/button";
import { Pill } from "../ui/pill";
import { Segmented } from "./form-parts";
import { NoteRow } from "./note-row";
import { PromptMeter, useOwnerName } from "./prompt-meter";

/** Filter buttons; the files hold four kinds (the prototype showed three). */
const FILTERS: [MemoryKind | "all", string][] = [
  ["all", "All"],
  ["fact", "Facts"],
  ["preference", "Preferences"],
  ["decision", "Decisions"],
  ["lesson", "Lessons"],
];
const TONE = { fact: "gray", preference: "blue", decision: "violet", lesson: "amber" } as const;

/** Age of a note from its `YYYY-MM-DD` day. */
const age = (day: string) => formatAge(Date.parse(`${day}T00:00:00`), Date.now());

/**
 * Memory of a bot: kind filter and search, the notes with edit and delete, an add row, the prompt
 * meter, the journal by day and where the files live. Every write refetches the notes.
 */
export function MemoryPanel({ owner }: { owner: MemoryOwner }) {
  const qc = useQueryClient();
  const name = useOwnerName(owner);
  const list = useQuery(orpc.memory.list.queryOptions({ input: { owner } }));
  const journal = useQuery(orpc.memory.journal.queryOptions({ input: { owner } }));
  const [filter, setFilter] = useState<MemoryKind | "all">("all");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<MemoryKind>("preference");
  const [text, setText] = useState("");
  const q = query.toLowerCase();
  const notes = (list.data?.notes ?? []).filter(
    (n) => (filter === "all" || n.kind === filter) && n.text.toLowerCase().includes(q),
  );
  /** Runs a write, then reloads the notes (and the meter); a refusal shows as a toast. */
  const write = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: orpc.memory.list.key() });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the memory.");
    }
  };
  // A note added in a kind's tab takes that kind; only All asks for one.
  const addKind = filter === "all" ? kind : filter;
  const add = async () => {
    await write(() => client.memory.save({ owner, kind: addKind, text: text.trim() }));
    setText("");
  };
  const [bucket, id] = owner.split(":");
  return (
    <>
      <div className="mem-head">
        <Segmented<MemoryKind | "all">
          label="Kind of note"
          fit
          options={FILTERS.map(([k]) => k)}
          names={Object.fromEntries(FILTERS)}
          value={filter}
          onChange={setFilter}
        />
        <span className="grow" />
        <input
          className="field"
          placeholder="Search memory"
          aria-label="Search memory"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="list-panel">
        {notes.map((n) => (
          <NoteRow
            key={n.id}
            noun="note"
            text={n.text}
            meta={
              <div className="nm">
                <Pill tone={TONE[n.kind]}>{n.kind}</Pill>
                {n.day && ` ${age(n.day)}`}
              </div>
            }
            onEdit={(t) => void write(() => client.memory.edit({ owner, id: n.id, text: t }))}
            onDelete={() => void write(() => client.memory.delete({ owner, id: n.id }))}
          />
        ))}
        {notes.length === 0 && (
          <div className="note">
            <div className="grow" style={{ color: "var(--label-2)" }}>
              No notes match.
            </div>
          </div>
        )}
        <div className="add-row">
          {filter === "all" && (
            <select
              className="field"
              style={{ width: "auto" }}
              aria-label="Kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as MemoryKind)}
            >
              {FILTERS.slice(1).map(([k, label]) => (
                <option key={k} value={k}>
                  {label.replace(/s$/, "")}
                </option>
              ))}
            </select>
          )}
          <input
            className="field"
            placeholder={`Add a note ${name} should remember`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && text.trim() && void add()}
          />
          <Button variant="primary" disabled={!text.trim()} onClick={() => void add()}>
            Add
          </Button>
        </div>
      </div>
      <PromptMeter
        name={name}
        used={list.data?.promptChars ?? 0}
        cap={list.data?.capChars ?? 12000}
      />
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 8px" }}>Journal</h3>
      <div className="list-panel">
        {(journal.data ?? []).map((j) => (
          <div className="journal-day" key={j.day}>
            <b>{j.day}</b>
            <ul>
              {j.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="foot-note">
        Stored as files in{" "}
        <span className="mono">
          ~/.friday/memory/{bucket}s/{id}/
        </span>{" "}
        (MEMORY.md and journal/).
      </div>
    </>
  );
}

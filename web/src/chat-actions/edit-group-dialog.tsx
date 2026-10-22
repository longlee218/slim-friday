import { type FormEvent, useEffect, useRef, useState } from "react";
import { useChat } from "../chat/chat-store";
import type { GroupChat } from "../chat/chat-types";
import { Field } from "../compose/form-parts";
import { Dialog } from "../ui/dialog";
import { DESCRIPTION_HINT, MAX_DESCRIPTION, MAX_GROUP_NAME } from "./group-limits";

/** Edit a group's name and description. Save stays off until something valid changed. */
export function EditGroupDialog({ chat, onClose }: { chat: GroupChat | null; onClose(): void }) {
  const { runtime } = useChat();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const input = useRef<HTMLInputElement>(null);
  // Each open starts from the group's current values, the name selected so typing replaces it.
  useEffect(() => {
    if (!chat) return;
    setName(chat.name);
    setDescription(chat.description);
    requestAnimationFrame(() => input.current?.select());
  }, [chat]);

  const clean = { name: name.trim(), description: description.trim() };
  const changed = !!chat && (clean.name !== chat.name || clean.description !== chat.description);
  const valid = clean.name.length > 0 && changed;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chat || !valid) return;
    runtime.updateGroup(chat.id, clean.name, clean.description);
    onClose();
  };

  return (
    <Dialog open={chat !== null} title="Edit group" onClose={onClose}>
      <form className="dialog__form" onSubmit={submit}>
        <Field label="Name" htmlFor="eg-name">
          <input
            id="eg-name"
            ref={input}
            className="input input--lg"
            value={name}
            maxLength={MAX_GROUP_NAME}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Field label="Description" htmlFor="eg-desc" hint={`${DESCRIPTION_HINT} ${description.length}/${MAX_DESCRIPTION}`}>
          <textarea
            id="eg-desc"
            className="input input--area"
            value={description}
            maxLength={MAX_DESCRIPTION}
            rows={4}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this group is for, and what done looks like."
          />
        </Field>
        <div className="dialog__actions">
          <button type="button" className="btn btn--lg" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--lg btn--primary" disabled={!valid}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  );
}

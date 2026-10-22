import { type FormEvent, useState } from "react";
import { useChat } from "../chat/chat-store";
import { ROLE_LABEL } from "../chat/role-labels";
import { DESCRIPTION_HINT, MAX_DESCRIPTION, MAX_GROUP_NAME } from "../chat-actions/group-limits";
import { Avatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { Field } from "./form-parts";

const DEFAULT_TURNS = 16;
const DEFAULT_COST = 5;

/**
 * New group: name, description (the goal members read), members (two or more),
 * the member who routes, and the per-request limits that pause the group.
 */
export function NewGroupForm({ onDone }: { onDone(chatId: string): void }) {
  const { state, runtime } = useChat();
  const lead = state.team.find((t) => t.role === "lead");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [members, setMembers] = useState<string[]>(lead ? [lead.id] : []);
  const [router, setRouter] = useState(lead?.id ?? "");
  const [maxTurns, setMaxTurns] = useState(DEFAULT_TURNS);
  const [maxCost, setMaxCost] = useState(DEFAULT_COST);
  const [tried, setTried] = useState(false);

  // The router must be a member; fall back to the first member when it leaves.
  const routerId = members.includes(router) ? router : (members[0] ?? "");
  const toggle = (id: string) =>
    setMembers((cur) => (cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id]));

  const errors = {
    name: name.trim() ? undefined : "Name the group.",
    members: members.length >= 2 ? undefined : "Pick at least two teammates.",
    turns: maxTurns >= 1 && maxTurns <= 50 ? undefined : "Between 1 and 50 turns.",
    cost: maxCost > 0 && maxCost <= 50 ? undefined : "Between $0.50 and $50.",
  };
  const valid = Object.values(errors).every((e) => !e);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!valid) return;
    onDone(
      runtime.createGroup({ name: name.trim(), description: description.trim(), members, router: routerId, maxTurns, maxCost }),
    );
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <Field label="Name" htmlFor="gr-name" error={tried ? errors.name : undefined}>
        <input
          id="gr-name"
          className="input input--lg"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Launch week"
          autoComplete="off"
          maxLength={MAX_GROUP_NAME}
          autoFocus
        />
      </Field>

      <Field label="Description" htmlFor="gr-desc" hint={`Optional. ${DESCRIPTION_HINT}`}>
        <textarea
          id="gr-desc"
          className="input input--area"
          value={description}
          maxLength={MAX_DESCRIPTION}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Ship the launch page by Friday. Done = live on the domain, Lighthouse 90+."
        />
      </Field>

      <Field
        label="Members"
        error={tried ? errors.members : undefined}
        hint={`${members.length} picked. The router decides who speaks next.`}
      >
        <ul className="pick-list">
          {state.team.map((t) => {
            const on = members.includes(t.id);
            return (
              <li key={t.id} data-on={on || undefined}>
                <label className="pick">
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(t.id)} />
                  <span className="pick__box" aria-hidden="true">
                    {on && <Icon name="check" size={14} />}
                  </span>
                  <Avatar name={t.avatar} size={28} />
                  <span className="pick__text">
                    {t.name}
                    <small>{ROLE_LABEL[t.role]}</small>
                  </span>
                </label>
                {on && (
                  <button
                    type="button"
                    className="pick__router"
                    data-on={t.id === routerId || undefined}
                    aria-pressed={t.id === routerId}
                    onClick={() => setRouter(t.id)}
                  >
                    {t.id === routerId ? "Routes" : "Make router"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Field>

      <div className="form__row">
        <Field label="Turns per request" htmlFor="gr-turns" error={tried ? errors.turns : undefined}>
          <input
            id="gr-turns"
            className="input input--lg"
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
          />
        </Field>
        <Field label="Cost per request" htmlFor="gr-cost" error={tried ? errors.cost : undefined}>
          <span className="input-affix">
            <span aria-hidden="true">$</span>
            <input
              id="gr-cost"
              className="input input--lg"
              type="number"
              inputMode="decimal"
              min={0.5}
              max={50}
              step={0.5}
              value={maxCost}
              onChange={(e) => setMaxCost(Number(e.target.value))}
            />
          </span>
        </Field>
      </div>
      <p className="form__note">The group pauses when either limit is reached; you can resume it.</p>

      <div className="form__actions">
        <button type="submit" className="btn btn--primary btn--lg">
          Create group
        </button>
      </div>
    </form>
  );
}

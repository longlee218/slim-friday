import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, useState } from "react";
import { useChat } from "../chat/chat-store";
import type { RoleKey } from "../chat/chat-types";
import { ROLE_LABEL } from "../chat/role-labels";
import { MODELS, ROLE_TEMPLATES } from "../chat/role-templates";
import { Avatar } from "../ui/avatar";
import { SPRING_SNAPPY } from "../ui/motion-presets";
import { Field, Segmented } from "./form-parts";

const ROLES = Object.keys(ROLE_TEMPLATES) as RoleKey[];
type Model = (typeof MODELS)[number];
const MODEL_OPTIONS = MODELS.map((m) => ({ value: m, label: m.replace(" 5.5", "") }));

/** New teammate: pick a role template, name it, choose a model, add your own instructions. */
export function NewTeammateForm({ onDone }: { onDone(chatId: string): void }) {
  const { state, runtime } = useChat();
  const [role, setRole] = useState<RoleKey>("developer");
  const [name, setName] = useState("");
  const [model, setModel] = useState<Model>("Sonnet 5.5");
  const [instructions, setInstructions] = useState("");
  const [tried, setTried] = useState(false);

  const clean = name.trim();
  const taken = state.team.some((t) => t.name.toLowerCase() === clean.toLowerCase());
  const nameError = !clean ? "Give your teammate a name." : taken ? `${clean} is already on your team.` : undefined;
  const tpl = ROLE_TEMPLATES[role];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (nameError) return;
    onDone(runtime.createTeammate({ name: clean, role, model, instructions: instructions.trim() }));
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <span className="field__label" id="tpl-label">
          Role
        </span>
        <div className="tiles" role="radiogroup" aria-labelledby="tpl-label">
          {ROLES.map((r) => (
            <label key={r} className="tile" data-on={r === role || undefined}>
              {r === role && <motion.span layoutId="tile-pick" className="tile__pill" transition={SPRING_SNAPPY} />}
              <input type="radio" className="sr-only" name="role" checked={r === role} onChange={() => setRole(r)} />
              <Avatar name={ROLE_TEMPLATES[r].avatar} size={44} />
              <span>{ROLE_LABEL[r]}</span>
            </label>
          ))}
        </div>
        {/* What the picked template does; swaps with the pick. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={role}
            className="tile-about"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16 }}
          >
            {tpl.summary} <span>{tpl.approvals}</span>
          </motion.p>
        </AnimatePresence>
      </div>

      <Field label="Name" htmlFor="tm-name" error={tried ? nameError : undefined}>
        <input
          id="tm-name"
          className="input input--lg"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nova"
          autoComplete="off"
          maxLength={32}
          autoFocus
        />
      </Field>

      <Field label="Model" hint="Opus thinks deeper and costs more; Haiku is fastest.">
        <Segmented<Model> id="model" label="Model" options={MODEL_OPTIONS} value={model} onChange={setModel} />
      </Field>

      <Field label="Your instructions" htmlFor="tm-ins" hint="Optional. Added on top of the role template.">
        <textarea
          id="tm-ins"
          className="input input--area"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Answer in Vietnamese. Ask before touching the database."
          rows={4}
        />
      </Field>

      <div className="form__actions">
        <button type="submit" className="btn btn--primary btn--lg">
          Create teammate
        </button>
      </div>
    </form>
  );
}

import { BotIdSchema, type GroupInputDto, GroupInputDtoSchema } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { TicketSelect } from "../tickets/ticket-select";
import { AutoTextarea } from "../ui/auto-textarea";
import { Avatar } from "../ui/avatar";
import { autoId } from "./auto-id";
import { Row, SaveBar, StaleNotice } from "./form-parts";
import { TokenList } from "./token-list";
import { type FieldErrors, useFormState } from "./use-form-state";

/** What the group form edits: the saved fields plus the id (typed once, when the group is new). */
export type GroupFormValue = GroupInputDto & { id: string };

/** The values of a group that does not exist yet. */
export const NEW_GROUP: GroupFormValue = {
  id: "",
  name: "",
  members: [],
  entryBot: "",
  workspaces: [],
  instructions: "",
};

/** Validates with the contract's schema, plus the id and "the entry bot is a member". */
export function validateGroup(v: GroupFormValue): FieldErrors<GroupFormValue> {
  const errors: FieldErrors<GroupFormValue> = {};
  const { id: _id, ...input } = v;
  const parsed = GroupInputDtoSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const key = i.path[0] as keyof GroupFormValue | undefined;
      if (key && !errors[key]) errors[key] = i.message;
    }
  }
  if (v.name.trim().length < 1) errors.name = "A group needs a name.";
  if (!BotIdSchema.safeParse(v.id).success) {
    errors.id = "Lowercase letters, digits and dashes; start with a letter; up to 32.";
  }
  if (v.members.length > 0 && !v.members.includes(v.entryBot)) {
    errors.entryBot = "The entry bot must be a member.";
  }
  return errors;
}

/** The group form: name, entry bot, members, workspaces, instructions. */
export function GroupForm({
  initial,
  mode,
  onSave,
}: {
  initial: GroupFormValue;
  mode: "create" | "update";
  onSave(value: GroupFormValue): Promise<unknown>;
}) {
  const form = useFormState(initial, validateGroup);
  const dir = useDirectory();
  const { value: v, set, errors } = form;
  const create = mode === "create";
  // A new group's id (file name, fixed for good) follows its name.
  const nameError = errors.name ?? (create ? errors.id : undefined);
  const face = (id: string) => (
    <Avatar src={dir.bots.get(id)?.avatarUrl} name={dir.botName(id)} size={16} />
  );
  return (
    <>
      {form.stale && <StaleNotice what="group" />}
      <div className="formgroup">
        <Row
          label="Name"
          htmlFor="g-name"
          help={create ? `File id: ${v.id || "–"}` : undefined}
          error={nameError}
        >
          <input
            id="g-name"
            className={nameError ? "field err" : "field"}
            value={v.name}
            onChange={(e) => {
              set("name", e.target.value);
              if (create) set("id", autoId(e.target.value.trim(), dir.groups.keys(), "group"));
            }}
          />
        </Row>
        <Row label="Members" top error={errors.members}>
          <TokenList
            plain
            values={v.members}
            options={[...dir.bots.keys()]}
            label={dir.botName}
            addLabel="Add member"
            onChange={(next) => {
              set("members", next);
              // The entry bot must stay a member: move it to the first one left (or clear it);
              // `set` marks it touched so its error shows.
              if (!next.includes(v.entryBot)) set("entryBot", next[0] ?? "");
            }}
          />
        </Row>
        <Row
          label="Entry bot"
          help="Gets your message when you don't @name anyone."
          error={errors.entryBot}
        >
          {v.members.length ? (
            <TicketSelect
              label="Entry bot"
              value={v.entryBot || null}
              options={v.members.map((m) => ({ value: m, node: dir.botName(m) }))}
              current={
                v.entryBot ? (
                  <>
                    {face(v.entryBot)}
                    {dir.botName(v.entryBot)}
                  </>
                ) : (
                  "Choose a member"
                )
              }
              onChange={(m) => set("entryBot", m)}
            />
          ) : (
            // Nothing to choose from yet: an empty picker would open an empty popup.
            <span style={{ color: "var(--label-2)" }}>Add a member first.</span>
          )}
        </Row>
        <Row label="Workspaces" top help="The first is the main project.">
          <TokenList
            values={v.workspaces}
            options={[]}
            addLabel="Grant folder"
            placeholder="Type a folder path"
            onChange={(next) => set("workspaces", next)}
          />
        </Row>
      </div>
      <div className="formgroup" style={{ padding: "12px 14px" }}>
        <label
          htmlFor="g-instructions"
          style={{ fontWeight: 500, display: "block", marginBottom: 8 }}
        >
          Instructions
        </label>
        <AutoTextarea
          id="g-instructions"
          className="field code"
          rows={6}
          value={v.instructions}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </div>
      <SaveBar
        dirty={form.dirty}
        valid={form.valid}
        saving={form.saving}
        onRevert={form.revert}
        onSave={() => void form.submit(onSave)}
      />
    </>
  );
}

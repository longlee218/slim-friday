import { EffortSchema } from "@friday/contracts";
import { TicketSelect } from "../tickets/ticket-select";
import { AutoTextarea } from "../ui/auto-textarea";
import type { BotFormValue } from "./bot-form-value";
import { Row, Segmented } from "./form-parts";
import type { FormState } from "./use-form-state";

const MODELS = ["haiku", "sonnet", "opus"];
const AUTONOMY = ["careful", "balanced", "autonomous"] as const;

/** Props of a bot tab: the form and whether the bot is read only (shipped). */
export interface BotTabProps {
  form: FormState<BotFormValue>;
  readOnly: boolean;
  /** `create` also asks for the name and the id. */
  mode: "create" | "update";
}

/** Profile tab: (new bot: name and id), title, model, effort, autonomy, instructions. */
export function BotProfileTab({ form, readOnly, mode }: BotTabProps) {
  const { value: v, set, errors } = form;
  const text = (key: "name" | "id" | "title", label: string, help?: string) => (
    <Row label={label} htmlFor={`f-${key}`} help={help} error={errors[key]}>
      <input
        id={`f-${key}`}
        className={errors[key] ? "field err" : "field"}
        value={v[key]}
        disabled={readOnly}
        onChange={(e) => set(key, e.target.value)}
      />
    </Row>
  );
  const models = MODELS.includes(v.model) ? MODELS : [v.model, ...MODELS];
  return (
    <>
      <div className="formgroup">
        {mode === "create" && text("name", "Name", "Shown in chats; mentions use @name.")}
        {mode === "create" && text("id", "Id", "The file name. It cannot change later.")}
        {text("title", "Title")}
        <Row label="Model">
          {readOnly ? (
            v.model
          ) : (
            <TicketSelect
              label="Model"
              value={v.model}
              options={models.map((m) => ({ value: m, node: m }))}
              current={v.model}
              onChange={(m) => set("model", m)}
            />
          )}
        </Row>
        <Row label="Effort" help="Leave unset to use the default.">
          <Segmented
            label="Effort"
            options={EffortSchema.options}
            value={v.effort}
            disabled={readOnly}
            onChange={(e) => set("effort", e)}
          />
        </Row>
        <Row label="Autonomy" error={errors.autonomy}>
          <Segmented
            label="Autonomy"
            options={AUTONOMY}
            value={v.autonomy}
            disabled={readOnly}
            onChange={(a) => set("autonomy", a)}
          />
        </Row>
      </div>
      <div className="formgroup" style={{ padding: "12px 14px" }}>
        <label
          htmlFor="f-instructions"
          style={{ fontWeight: 500, display: "block", marginBottom: 8 }}
        >
          Instructions
        </label>
        <AutoTextarea
          id="f-instructions"
          className="field"
          rows={6}
          style={{ fontFamily: "var(--mono)", fontSize: 12.5 }}
          value={v.instructions}
          disabled={readOnly}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </div>
    </>
  );
}

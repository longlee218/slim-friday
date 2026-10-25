import { EffortSchema } from "@friday/contracts";
import { useDirectory } from "../../api/directory";
import { TicketSelect } from "../tickets/ticket-select";
import { AutoTextarea } from "../ui/auto-textarea";
import { autoId } from "./auto-id";
import type { BotFormValue } from "./bot-form-value";
import { Row, Segmented } from "./form-parts";
import type { FormState } from "./use-form-state";

const MODELS = ["haiku", "sonnet", "opus"];
const AUTONOMY = ["careful", "balanced", "autonomous"] as const;

/** Props of a bot tab: the form and whether the bot is read only (shipped). */
export interface BotTabProps {
  form: FormState<BotFormValue>;
  readOnly: boolean;
  /** `create` also asks for the name (the id is made from it). */
  mode: "create" | "update";
}

/** Profile tab: (new bot: name, its id made from it), title, model, effort, autonomy, instructions. */
export function BotProfileTab({ form, readOnly, mode }: BotTabProps) {
  const { value: v, set, errors } = form;
  const dir = useDirectory();
  const text = (key: "title", label: string, help?: string) => (
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
        {mode === "create" && (
          // The id (file name, fixed for good) follows the name; mentions use the name itself.
          <Row
            label="Name"
            htmlFor="f-name"
            help={`Mention it as @${v.name.trim() || "name"}. File id: ${v.id || "–"}`}
            error={errors.name ?? errors.id}
          >
            <input
              id="f-name"
              className={errors.name || errors.id ? "field err" : "field"}
              value={v.name}
              onChange={(e) => {
                set("name", e.target.value);
                set("id", autoId(e.target.value.trim(), dir.bots.keys(), "bot"));
              }}
            />
          </Row>
        )}
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

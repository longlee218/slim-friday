import { EffortSchema } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../api/client";
import { useDirectory } from "../../api/directory";
import { TicketSelect } from "../tickets/ticket-select";
import { AutoTextarea } from "../ui/auto-textarea";
import { autoId } from "./auto-id";
import type { BotFormValue } from "./bot-form-value";
import { Group, Row, Segmented } from "./form-parts";
import type { FormState } from "./use-form-state";

/** The picker while the runtime list is loading or failed. */
const FALLBACK_MODELS = ["haiku", "sonnet", "opus"];
const AUTONOMY = ["careful", "balanced", "autonomous"] as const;

/**
 * Effort and Autonomy may stay unset, which shows no chosen segment; the footnote says what
 * applies then (the model's default effort, the autonomy level from settings).
 */
function unsetNote(v: BotFormValue): string | undefined {
  const notes = [
    !v.effort && "No Effort chosen: the model's default applies.",
    !v.autonomy && "No Autonomy chosen: the level from settings applies.",
  ].filter(Boolean);
  return notes.length ? notes.join(" ") : undefined;
}

/** Props of a bot tab: the form and whether the bot is read only (shipped). */
export interface BotTabProps {
  form: FormState<BotFormValue>;
  readOnly: boolean;
  /** `create` also makes the id from the name. */
  mode: "create" | "update";
}

/** Profile tab: name (a new bot's id is made from it), title, model, effort, autonomy, instructions. */
export function BotProfileTab({ form, readOnly, mode }: BotTabProps) {
  const { value: v, set, errors } = form;
  const dir = useDirectory();
  const create = mode === "create";
  const nameError = errors.name ?? (create ? errors.id : undefined);
  const text = (key: "title", label: string, help?: string) => (
    <Row label={label} htmlFor={`f-${key}`} help={help} error={errors[key]}>
      <input
        id={`f-${key}`}
        placeholder="Optional"
        className={errors[key] ? "field err" : "field"}
        value={v[key]}
        disabled={readOnly}
        onChange={(e) => set(key, e.target.value)}
      />
    </Row>
  );
  // The runtime's own list (aliases and full ids); the saved value stays choosable even if it is not in it.
  const listed = useQuery(orpc.config.models.list.queryOptions({ staleTime: 5 * 60_000 })).data;
  const known = new Map(listed?.map((m) => [m.value, m.displayName]));
  const ids = listed?.length ? [...known.keys()] : FALLBACK_MODELS;
  const models = ids.includes(v.model) ? ids : [v.model, ...ids];
  const modelNode = (m: string) => {
    const name = known.get(m);
    return name && name !== m ? `${name} (${m.replace(/\[1m\]$/, "")})` : m;
  };
  return (
    <>
      <Group foot={unsetNote(v)}>
        {/* Mentions use the name itself; a new bot's id (file name, fixed for good) follows it. */}
        <Row
          label="Name"
          htmlFor="f-name"
          help={`Mention it as @${v.name.trim() || "name"}.${create && v.id ? ` File id: ${v.id}` : ""}`}
          error={nameError}
        >
          <input
            id="f-name"
            placeholder="Required"
            className={nameError ? "field err" : "field"}
            value={v.name}
            disabled={readOnly}
            onChange={(e) => {
              set("name", e.target.value);
              if (create) set("id", autoId(e.target.value.trim(), dir.bots.keys(), "bot"));
            }}
          />
        </Row>
        {text("title", "Title")}
        <Row label="Model">
          {readOnly ? (
            v.model
          ) : (
            <TicketSelect
              label="Model"
              value={v.model}
              options={models.map((m) => ({ value: m, node: modelNode(m) }))}
              current={modelNode(v.model)}
              onChange={(m) => set("model", m)}
            />
          )}
        </Row>
        <Row label="Effort">
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
      </Group>
      <Group title={<label htmlFor="f-instructions">Instructions</label>} wide>
        <AutoTextarea
          id="f-instructions"
          className="field code"
          rows={6}
          value={v.instructions}
          disabled={readOnly}
          onChange={(e) => set("instructions", e.target.value)}
        />
      </Group>
    </>
  );
}

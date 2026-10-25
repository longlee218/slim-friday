import { type BotFormValue, validateBot } from "./bot-form-value";
import { BotProfileTab } from "./bot-profile-tab";
import { BotToolsTab } from "./bot-tools-tab";
import { SaveBar, StaleNotice } from "./form-parts";
import { useFormState } from "./use-form-state";

export type { BotFormValue } from "./bot-form-value";

export interface BotFormProps {
  initial: BotFormValue;
  mode: "create" | "update";
  /** Which of the two form tabs shows; the state is kept when it changes. */
  tab: "profile" | "tools";
  /** Shipped bots are read only: no save bar. */
  shipped?: boolean;
  onSave(value: BotFormValue): Promise<unknown>;
}

/**
 * The bot's Profile and Tools & skills tabs over one form state, so a change made on one tab
 * survives a switch to the other. Fields are listed by hand and validated on change with the
 * contract's zod schema.
 */
export function BotForm({ initial, mode, tab, shipped = false, onSave }: BotFormProps) {
  const form = useFormState(initial, validateBot);
  const props = { form, readOnly: shipped, mode };
  return (
    <>
      {form.stale && <StaleNotice what="bot" />}
      {shipped && <div className="foot-note">Shipped with Friday: read only.</div>}
      {tab === "profile" ? <BotProfileTab {...props} /> : <BotToolsTab {...props} />}
      {!shipped && (
        <SaveBar
          dirty={form.dirty}
          valid={form.valid}
          saving={form.saving}
          onRevert={form.revert}
          onSave={() => void form.submit(onSave)}
        />
      )}
    </>
  );
}

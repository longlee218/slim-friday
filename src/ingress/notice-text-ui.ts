import type { OwnerLanguage } from "../i18n/languages";
import { t } from "../i18n/translate";
import type { UserNotice } from "./user-copy";

/** Notices for buttons, labels, choices and channel adoption. */
export type UiNotice = Extract<
  UserNotice,
  {
    kind:
      | "ask-after-location"
      | "channel-adopted"
      | "channel-adopt-refused"
      | "approval"
      | "choice"
      | "label";
  }
>;

const UI_KINDS: ReadonlySet<string> = new Set<UiNotice["kind"]>([
  "ask-after-location",
  "channel-adopted",
  "channel-adopt-refused",
  "approval",
  "choice",
  "label",
]);

/** Type guard: true for the notices this module renders. */
export const isUiNotice = (event: UserNotice): event is UiNotice => UI_KINDS.has(event.kind);

/** Render a UI notice in the owner's language. */
export function renderUiNotice(event: UiNotice, language: OwnerLanguage): string {
  switch (event.kind) {
    case "ask-after-location":
      return t(language, "ui.askAfterLocation", { name: event.name ?? "" });
    case "channel-adopted":
      return t(language, "ui.channelAdopted", { name: event.name, space: event.space });
    case "channel-adopt-refused":
      return t(language, `ui.adoptRefused.${event.reason}`);
    case "approval":
      return t(language, `ui.approval.${event.state}`);
    case "label":
      return t(language, `ui.label.${event.state}`);
    case "choice":
      return t(language, `ui.choice.${event.state}`, { text: event.text });
  }
}

import type { StoredMessage } from "../domain/message";
import type { Store } from "../ports/store";
import type { Surface } from "../ports/surface";
import { redactSecrets, redactStep, secretsFrom } from "../safety/redact-secrets";

/**
 * Store a message, then post it with its row id, so every posted message can be found again
 * (replies, pagination, read marks). A failing post rejects and the row stays: history keeps it.
 * Secrets are redacted first (text and run step labels), so neither the row nor the surface ever sees one.
 */
export async function postStored(
  deps: {
    store: Pick<Store, "messages">;
    surface: Surface;
    /** The configured secret values to hide (the app's denied env values). */
    secretValues?: () => string[];
  },
  raw: StoredMessage,
): Promise<number> {
  const values = secretsFrom(deps.secretValues);
  const m: StoredMessage = {
    ...raw,
    text: redactSecrets(raw.text, values),
    ...(raw.run && { run: raw.run.map((s) => redactStep(s, values)) }),
  };
  const id = await deps.store.messages.append(m);
  await deps.surface.post(m.conversationId, { ...m, id });
  return id;
}

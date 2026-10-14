import { logger } from "../observability/logger";
import { errText } from "../observability/redact";

/** A delayed per-message receipt; Discord failures never prevent the answer. */
export function createMessageReceipt(
  react: () => Promise<void>,
  remove: () => Promise<void>,
  delayMs = 2000,
): { visible(): Promise<void>; dispose(): void } {
  let reaction: Promise<boolean> | undefined;
  let visible: Promise<void> | undefined;
  const timer = setTimeout(() => {
    reaction = Promise.resolve()
      .then(react)
      .then(
        () => true,
        (err) => {
          logger.warn({ err: errText(err) }, "message receipt reaction failed");
          return false;
        },
      );
  }, delayMs);
  timer.unref();
  return {
    visible() {
      clearTimeout(timer);
      // Wait for the reaction request before removal, so a late request cannot leave an emoji behind.
      visible ??= (async () => {
        if (reaction && (await reaction)) {
          try {
            await remove();
          } catch (err) {
            logger.warn({ err: errText(err) }, "message receipt removal failed");
          }
        }
      })();
      return visible;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

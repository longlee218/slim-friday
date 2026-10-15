/* A worker's OS sandbox is required (`failIfUnavailable`): when it cannot start, the run must fail loudly with a code the lead
   can read, never hang, retry in a loop or fall back to an unsandboxed shell. */

/** Code of the failure; it leads the message the lead receives in the `failure` event. */
export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";

/** Error text of the SDK / CLI when the required sandbox did not start (macOS Seatbelt, Linux bubblewrap, missing deps). */
const SANDBOX_TEXT =
  /sandbox[^\n]*(unavailable|not available|not supported|could not|couldn't|failed to|cannot|can't|missing|required)|(unavailable|not available|failed to (start|initiali[sz]e)|missing)[^\n]*sandbox|bubblewrap|\bbwrap\b|sandbox-exec|failIfUnavailable/i;

/** True when an error text (a thrown query error or a result error) says the required sandbox is not usable. */
export const isSandboxFailure = (text: string): boolean => SANDBOX_TEXT.test(text);

/** Thrown by `runAgent` when a run that required the sandbox could not get it: the caller's crash path turns it into a `failure` event. */
export class SandboxUnavailableError extends Error {
  readonly code = SANDBOX_UNAVAILABLE;
  constructor(detail: string) {
    super(
      `${SANDBOX_UNAVAILABLE}: the OS sandbox this worker requires could not start, so nothing ran. Fix the machine (macOS Seatbelt, or Linux bubblewrap + socat) and dispatch again. Detail: ${detail.slice(0, 200)}`,
    );
    this.name = "SandboxUnavailableError";
  }
}

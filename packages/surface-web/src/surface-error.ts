/** A refusal the API layer maps to an HTTP status; the message is safe to show to the owner. */
export class SurfaceError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "BAD_REQUEST" | "PAYLOAD_TOO_LARGE" | "CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "SurfaceError";
  }
}

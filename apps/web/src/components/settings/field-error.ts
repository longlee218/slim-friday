/** What a failed save says: the message, and the form field it names (only for `BAD_REQUEST`). */
export interface SaveFailure {
  message: string;
  field?: string;
}

/** Reads an oRPC error: `BAD_REQUEST` may carry `data.field` (the form field to mark). */
export function saveFailure(e: unknown): SaveFailure {
  const err = e as { code?: string; message?: string; data?: { field?: unknown } } | null;
  const message = err?.message || "Could not save";
  const field = err?.code === "BAD_REQUEST" ? err.data?.field : undefined;
  return typeof field === "string" ? { message, field } : { message };
}

/** True when the error is a `BAD_REQUEST` (the owner can fix it, so it is shown by the field). */
export function isBadRequest(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "BAD_REQUEST";
}

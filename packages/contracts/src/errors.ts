import { oc } from "@orpc/contract";

/** The typed errors every procedure may return, with their HTTP status. */
export const API_ERRORS = {
  UNAUTHORIZED: { status: 401 },
  NOT_FOUND: { status: 404 },
  CONFLICT: { status: 409 },
  BAD_REQUEST: { status: 400 },
  PAYLOAD_TOO_LARGE: { status: 413 },
  NOT_IMPLEMENTED: { status: 501 },
} as const;

/** The builder every procedure starts from, so each one declares all six errors. */
export const base = oc.errors(API_ERRORS);

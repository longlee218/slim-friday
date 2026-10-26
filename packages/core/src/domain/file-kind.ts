/** The groups the file library filters by. */
export type FileKind = "image" | "pdf" | "other";

/** Mime types of the `image` kind (the same list the upload check shows inline). */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** The mime type of the `pdf` kind. */
export const PDF_MIME_TYPE = "application/pdf";

/** Keyset position in the file library: the last row of a page. */
export interface FileCursor {
  at: number;
  id: string;
}

/** The kind a stored mime type belongs to. */
export function fileKindOf(mimeType: string): FileKind {
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return "image";
  return mimeType === PDF_MIME_TYPE ? "pdf" : "other";
}

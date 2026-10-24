import { createHash } from "node:crypto";
import { normalizeBullet } from "./memory-sections";

/** Audit key of a memory bullet: first 16 hex chars of sha1 over its normalized text (date and markup out). */
export const bulletHash = (bullet: string): string =>
  createHash("sha1").update(normalizeBullet(bullet)).digest("hex").slice(0, 16);

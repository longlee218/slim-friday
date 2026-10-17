import type { Database } from "bun:sqlite";
import { foldText } from "../memory/index/fold-text";
import { ftsInsert } from "../storage/artifact-store";
import { chunkBody } from "./artifact-chunks";

/**
 * Full-text index of one artifact body: chunks, each folded like a query term (accents and `đ` removed; folding keeps
 * the length, so the snippet can be cut from the original spelling). No-op for an empty body.
 */
export function indexArtifact(
  db: Database,
  a: { id: string; workspace: string; channel: string },
  body: string,
): void {
  const chunks = chunkBody(body.normalize("NFC")).map((orig) => ({ folded: foldText(orig), orig }));
  if (chunks.length) ftsInsert(db, a, chunks);
}

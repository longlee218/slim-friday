import { ARTIFACT_CHUNK_CHARS } from "./artifact-limits";

/**
 * Split a body into search chunks of at most `ARTIFACT_CHUNK_CHARS`: paragraphs (blank-line separated) are packed
 * together, a paragraph longer than the limit is cut in fixed windows. Blank chunks are dropped. Pure.
 */
export function chunkBody(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const para of text.split(/\n\s*\n/)) {
    if (cur && cur.length + para.length + 2 > ARTIFACT_CHUNK_CHARS) flush();
    if (para.length > ARTIFACT_CHUNK_CHARS) {
      flush();
      for (let i = 0; i < para.length; i += ARTIFACT_CHUNK_CHARS)
        out.push(para.slice(i, i + ARTIFACT_CHUNK_CHARS));
    } else cur = cur ? `${cur}\n\n${para}` : para;
  }
  flush();
  return out.filter((c) => c.trim());
}

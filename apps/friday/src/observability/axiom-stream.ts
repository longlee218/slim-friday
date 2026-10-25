import { Axiom } from "@axiomhq/js";

/** The only keys that leave the machine: ids, enums and timings. Message text and excerpts are never listed. */
export const AXIOM_FIELDS = [
  "event",
  "wakeId",
  "chainId",
  "botId",
  "scheduleId",
  "intent",
  "hop",
  "status",
  // web API metadata (never bodies or query strings)
  "route",
  "method",
  "ms",
  "server",
  "via",
  "reason",
  "blockReason",
  "queue_wait_ms",
  "first_response_ms",
  "total_ms",
  "attempts",
  "level",
  "time",
  "module",
] as const;

/** The two client methods the stream uses (the real `Axiom` client batches `ingest` internally). */
export interface AxiomClient {
  ingest(dataset: string, events: object[]): void;
  flush(): Promise<unknown>;
}

/** Keep only allow-listed keys of one JSON log line. */
export function pickAxiomFields(line: string): Record<string, unknown> {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of AXIOM_FIELDS) if (parsed[k] !== undefined) out[k] = parsed[k];
  return out;
}

/** A pino stream that ships lifecycle events (lines with an `event`) to a dataset. Never throws. */
export function axiomStream(client: AxiomClient, dataset: string) {
  /** Report a shipping failure on stderr (the logger itself must not recurse into this stream). */
  const report = (err: unknown) =>
    process.stderr.write(`axiom: ${err instanceof Error ? err.message : String(err)}\n`);
  return {
    write(line: string): void {
      try {
        const fields = pickAxiomFields(line);
        if (fields.event !== undefined) client.ingest(dataset, [fields]);
      } catch (err) {
        report(err);
      }
    },
    /** Send what is buffered (call at shutdown). */
    async flush(): Promise<void> {
      await client.flush().catch(report);
    },
  };
}

/** The stream for the real service, or undefined unless both token and dataset are set. */
export function axiomStreamFrom(token: string | undefined, dataset: string | undefined) {
  if (!token || !dataset) return undefined;
  return axiomStream(new Axiom({ token }), dataset);
}

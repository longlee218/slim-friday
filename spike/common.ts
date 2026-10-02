// Shared helpers for spike scripts: scratch paths, redaction, message logging.
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export const SCRATCH =
  "/private/tmp/claude-501/-Users-longlh-orca-projects-friday-slim-agent/6d43ebeb-230d-4143-bbb2-a3b8f9ffe1ea/scratchpad";
export const PROJ = `${SCRATCH}/proj`; // has tiny CLAUDE.md + 3 files
export const PROJ2 = `${SCRATCH}/proj2`; // different cwd, no CLAUDE.md
export const MODEL = "claude-haiku-4-5-20251001";

// Redact token-like strings (sk-..., long base64-ish) from any logged text.
export function redact(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[REDACTED-LONG]");
}

export function trunc(v: unknown, n = 300): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const r = redact(s ?? "");
  return r.length > n ? r.slice(0, n) + `...(+${r.length - n})` : r;
}

// One-line summary of a message: type/subtype/keys + short text preview.
export function logMsg(m: SDKMessage, tag = ""): void {
  const a = m as any;
  console.log(
    `${tag}[${a.type}${a.subtype ? "/" + a.subtype : ""}] keys=${Object.keys(a).join(",")}`,
  );
  if (a.type === "assistant" || a.type === "user") {
    const c = a.message?.content;
    if (Array.isArray(c))
      for (const b of c)
        console.log(`${tag}   block ${b.type}: ${trunc(b.text ?? b.input ?? b.content ?? b.name, 200)}`);
  }
  if (a.type === "result")
    console.log(`${tag}   result=${trunc(a.result, 300)} is_error=${a.is_error} turns=${a.num_turns} cost=${a.total_cost_usd} errors=${trunc(a.errors, 200)}`);
}

// Extract the assistant's final text from a result message.
export function resultText(m: SDKMessage): string {
  const a = m as any;
  return a.type === "result" ? String(a.result ?? "") : "";
}

/* Owner-run live smoke of packages/memory-honcho against a real Honcho (free, NOT part of `bun test`):
   HONCHO_URL=http://127.0.0.1:8000 bun scripts/smoke-honcho.ts      (HONCHO_API_KEY when auth is on)
   Server: scripts/setup-honcho.sh. Uses workspace `friday-smoke` and a fresh bot id per run, so it never touches
   real notes. Checks: write then semantic search (other words, other language), owner isolation, forget. */
import type { MemoryOwner, RecallSource } from "@friday/core";
import { HONCHO_API_KEY_ENV, honchoPlugin } from "../packages/memory-honcho/src/index";

const baseUrl = Bun.env.HONCHO_URL ?? "http://127.0.0.1:8000";
const secrets = { [HONCHO_API_KEY_ENV]: Bun.env[HONCHO_API_KEY_ENV] };
const options = honchoPlugin.parseOptions({ baseUrl, workspace: "friday-smoke" });
const problems = honchoPlugin.check(options, secrets);
if (problems.length) throw new Error(problems.join("; "));
const log = { warn: (data: object, msg: string) => console.warn(msg, data) };
const source: RecallSource = honchoPlugin.create(options, secrets, { log });

const run = Date.now().toString(36);
const me: MemoryOwner = { kind: "bot", botId: `smoke-${run}` };
const other: MemoryOwner = { kind: "bot", botId: `smoke-other-${run}` };
const note = "The owner deploys every service with Docker Compose on a single VPS.";
let failed = 0;

/** Print one check and count a failure. */
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

/** Search one owner with a fresh 15 s signal. */
const search = (owner: MemoryOwner, text: string) =>
  source.search({ owner, text, limit: 5, signal: AbortSignal.timeout(15_000) });

const t0 = performance.now();
await source.write?.(me, { text: note, kind: "Facts" });
console.log(`write ${Math.round(performance.now() - t0)} ms`);

const t1 = performance.now();
const english = await search(me, "how does the owner ship services to production?");
console.log(`search ${Math.round(performance.now() - t1)} ms`);
check("semantic search finds the note", english[0]?.text === note, english[0]?.text);

const vietnamese = await search(me, "chủ nhân triển khai dịch vụ bằng gì?");
check("Vietnamese query finds the English note", vietnamese[0]?.text === note, vietnamese[0]?.text);

const leaked = await search(other, "Docker Compose VPS");
check("another owner sees nothing", !leaked.some((h) => h.text === note), `${leaked.length} hits`);

await source.forget?.(me, note);
const gone = await search(me, "Docker Compose VPS");
check("forget removes the note", !gone.some((h) => h.text === note), `${gone.length} hits`);

process.exit(failed ? 1 : 0);

/* Owner-run live smoke of the note calls with SDK structured output (a few cents, NOT part of `bun test`):
   bun run scripts/smoke-note-calls.ts
   One `extractNotes` call, then one `consolidateNotes` call on the notes it returned (as a journal would hold them),
   on the summary model. Checks that each answers through `structured_output` in the expected shape (a failed call or
   a wrong shape rejects / gives undefined) and that the deploy choice is promoted as a `decision`. */
import { consolidateNotes, extractNotes } from "@friday/runtime-claude";
import { HAIKU_SUMMARY_MODEL } from "../apps/friday/src/config/model-ids";

const token = Bun.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN missing (put it in .env)");
const opts = { model: HAIKU_SUMMARY_MODEL, env: Bun.env, oauthToken: token, today: "2026-10-24" };
let failed = 0;

/** Print one check and count a failure. */
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}  ${JSON.stringify(detail)}`);
  if (!ok) failed++;
}

const summary = [
  "user: From now on answer me in Vietnamese, short, no preamble.",
  "assistant: Understood.",
  "user: We decided to deploy Friday with Docker Compose on one VPS, because it is cheap.",
].join("\n");

const t0 = performance.now();
let notes: string[] = [];
try {
  notes = (await extractNotes(summary, { ...opts, source: "transcript" })).map((n) => n.note);
  console.log(`extract ${Math.round(performance.now() - t0)} ms`);
  check("extractNotes answers a list of notes", notes.length > 0, notes);
} catch (err) {
  check("extractNotes answers a list of notes", false, String(err));
}
if (!notes.length) process.exit(1);

const t1 = performance.now();
const promoted = await consolidateNotes(
  {
    memory: "[1] (preference) Owner wants answers in English.",
    notes,
    today: "2026-10-24",
  },
  opts,
);
console.log(`consolidate ${Math.round(performance.now() - t1)} ms`);
check("consolidateNotes answers promoted notes", Array.isArray(promoted), promoted);
const deploy = promoted?.find((p) => /docker/i.test(p.note));
check("the deploy choice is promoted as a decision", deploy?.kind === "decision", deploy);

process.exit(failed ? 1 : 0);

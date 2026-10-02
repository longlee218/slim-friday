// Q12: run N concurrent query() calls held open (canUseTool waits) and sample process count + RSS.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ } from "./common";

const N = Number(process.argv[2] ?? 3);

// List SDK-spawned claude processes that are descendants of this bun process (pid, rss KB, etime).
function sample(label: string) {
  const out = Bun.spawnSync(["ps", "-eo", "pid,ppid,rss,command"]).stdout.toString().split("\n");
  const rows = out.map((l) => l.trim().split(/\s+/)).filter((c) => (c.slice(3).join(" ")).includes("claude-agent-sdk-darwin-arm64/claude") && c[1] === String(process.pid));
  const kids = rows.map((c) => ({ pid: c[0], rssMB: Math.round(Number(c[2]) / 1024) }));
  const parentMB = Math.round(process.memoryUsage().rss / 1048576);
  console.log(`${label}: sdk child procs=${kids.length} childRSS(MB)=${kids.map((k) => k.rssMB).join("/")} sum=${kids.reduce((s, k) => s + k.rssMB, 0)} bun parent RSS=${parentMB}MB`);
}

sample("baseline");
const runs = Array.from({ length: N }, (_, i) =>
  (async () => {
    for await (const _m of query({
      prompt: "Create file c" + i + ".txt containing 'ok' using Write. Then say done.",
      options: {
        cwd: PROJ, model: MODEL, maxTurns: 3, settingSources: [], tools: ["Write"],
        // Hold the session open ~20s so all N overlap while we sample.
        canUseTool: async (_t, input) => { await new Promise((r) => setTimeout(r, 20000)); return { behavior: "deny", message: "spike: no write" }; },
      },
    })) { /* drain */ }
  })(),
);
for (const t of [8000, 14000]) { await new Promise((r) => setTimeout(r, t === 8000 ? 8000 : 6000)); sample(`+${t / 1000}s (all N alive, awaiting permission)`); }
await Promise.all(runs);
sample("after finish");

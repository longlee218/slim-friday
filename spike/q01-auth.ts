// Q1: does auth work with what's in env / local login; does a dummy ANTHROPIC_API_KEY override it?
import { query } from "@anthropic-ai/claude-agent-sdk";
import { MODEL, PROJ, logMsg } from "./common";

const mode = process.argv[2] ?? "default"; // default | dummykey | dummyoauth | both
console.log("env CLAUDE_CODE_OAUTH_TOKEN:", process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "unset");
console.log("env ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "set" : "unset");

// Child env only: dummy invalid API key to see if it takes priority over stored login.
// Hard stop after 25s in case the SDK retries an invalid key forever.
const ac = new AbortController();
setTimeout(() => { console.log("ABORT after 25s (no result)"); ac.abort(); }, 25000);
const env = { ...process.env, ...(mode === "dummykey" || mode === "both" ? { ANTHROPIC_API_KEY: "sk-ant-dummy-invalid-0000000000" } : {}),
  ...(mode === "dummyoauth" || mode === "both" ? { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-dummy-invalid-0000000000" } : {}) };

try {
  for await (const m of query({
    prompt: "Reply with the single word: ok",
    options: { cwd: PROJ, model: MODEL, maxTurns: 1, tools: [], settingSources: [], env, abortController: ac },
  })) {
    logMsg(m, `[${mode}] `);
    const a = m as any;
    if (a.type === "system" && a.subtype === "init") console.log("   apiKeySource=", a.apiKeySource);
    if (a.subtype === "api_retry") console.log("   retry status=", a.error_status, "err=", String(a.error).slice(0,100));
    if (a.type === "assistant") console.log("   assistant.error=", a.error);
  }
} catch (e) {
  console.log("THROWN:", String(e).slice(0, 300));
}

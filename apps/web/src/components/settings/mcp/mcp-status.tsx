import type { McpTestDto } from "@friday/contracts";
import { CircleCheck, KeyRound, LoaderCircle, OctagonAlert } from "lucide-react";
import { useCallback, useState } from "react";
import { client } from "../../../api/client";
import { Button } from "../../ui/button";
import type { McpFormValue } from "./mcp-spec";
import { toSpec } from "./mcp-spec";

/** A probe result: `running` while the server starts, `undefined` before any test. */
export interface McpProbe {
  result?: McpTestDto;
  running: boolean;
  /** Starts the server on the host with this spec; a failed call is an `error` result. */
  run(name: string, value: McpFormValue): Promise<void>;
}

/** Runs `config.mcp.test` and keeps the latest result. */
export function useMcpProbe(): McpProbe {
  const [result, setResult] = useState<McpTestDto>();
  const [running, setRunning] = useState(false);
  const run = useCallback(async (name: string, value: McpFormValue) => {
    setRunning(true);
    try {
      setResult(await client.config.mcp.test({ name, server: toSpec(value) }));
    } catch (e) {
      setResult({ state: "error", message: (e as Error).message || "The test failed" });
    } finally {
      setRunning(false);
    }
  }, []);
  return { result, running, run };
}

const count = (r: McpTestDto) => `${r.tools?.length ?? 0} tools`;

/** The one-line status (prototype `.status`): not tested, starting or connected. */
export function McpStatusLine({ probe }: { probe: McpProbe }) {
  if (probe.running) {
    return (
      <span className="status">
        <LoaderCircle size={14} className="spin" /> Starting…
      </span>
    );
  }
  if (probe.result?.state !== "connected") return <span className="t2">Not tested yet</span>;
  return (
    <span className="status">
      <span className="sdot" style={{ background: "var(--green-dot)" }} />
      {`Connected · ${count(probe.result)}`}
    </span>
  );
}

/**
 * The status banner (prototype `.conn`): green when connected, amber when the server needs
 * sign-in, red with the error in mono when it failed. Shows nothing before the first test.
 */
export function ConnBanner({ probe, onTest }: { probe: McpProbe; onTest(): void }) {
  const { result, running } = probe;
  if (running) {
    return (
      <div className="conn">
        <LoaderCircle size={18} className="spin" />
        <div className="grow">Testing…</div>
      </div>
    );
  }
  if (!result) return null;
  const failed = result.state === "error";
  const tone = result.state === "connected" ? "ok" : failed ? "bad" : "warn";
  return (
    <div className={`conn ${tone}`}>
      {tone === "ok" ? <CircleCheck /> : failed ? <OctagonAlert /> : <KeyRound />}
      <div className="grow">
        {result.state === "connected" && (
          <>
            <b>Connected</b> · {count(result)}
          </>
        )}
        {result.state === "needs_auth" && (
          <>
            <b>Needs sign-in.</b> {result.message}
          </>
        )}
        {failed && (
          <>
            <b>Failed to start.</b> <span className="mono">{result.message}</span>
          </>
        )}
      </div>
      <Button onClick={onTest}>{failed ? "Retry" : "Test again"}</Button>
    </div>
  );
}

import type { McpServerDto } from "@friday/contracts";
import { useEffect } from "react";
import { fromServer } from "./mcp/mcp-spec";
import { useMcpProbe } from "./mcp/mcp-status";
import { selectedTools, withSelectedTools } from "./mcp-tool-entries";

/** Look of the All / None buttons: text links. */
const LINK = {
  border: 0,
  background: "none",
  padding: 0,
  font: "inherit",
  color: "var(--tint-text)",
  fontWeight: 600,
} as const;

/**
 * The tools of one MCP server as checkboxes. The list is read by starting the saved server (the connection test), so
 * it shows once the server answers; a server that needs sign-in or fails shows why instead. Checking every tool
 * keeps the whole-server entry, checking some keeps one entry per tool.
 */
export function McpToolPicker({
  server,
  entries,
  disabled,
  onChange,
}: {
  server: McpServerDto;
  /** The bot's `tools` entries. */
  entries: string[];
  disabled?: boolean;
  onChange(entries: string[]): void;
}) {
  const probe = useMcpProbe();
  // Start the saved server once when the picker opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `probe.run` is stable; the server is read once
  useEffect(() => void probe.run(server.name, fromServer(server)), [server.name, probe.run]);

  if (probe.running || !probe.result) return <div className="t2">Reading the tools…</div>;
  const r = probe.result;
  if (r.state !== "connected")
    return (
      <div className="t2">
        {r.state === "needs_auth"
          ? "Sign in to this server in Settings → MCP servers first."
          : (r.message ?? "The server did not start.")}
      </div>
    );
  const all = r.tools ?? [];
  const chosen = selectedTools(entries, server.name, all);
  const apply = (next: Set<string>) => onChange(withSelectedTools(entries, server.name, all, next));
  const toggle = (tool: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(tool);
    else next.delete(tool);
    apply(next);
  };
  return (
    <div>
      <div className="t2" style={{ marginBottom: 6 }}>
        {chosen.size} of {all.length} tools.{" "}
        <button type="button" style={LINK} disabled={disabled} onClick={() => apply(new Set(all))}>
          All
        </button>{" "}
        <button type="button" style={LINK} disabled={disabled} onClick={() => apply(new Set())}>
          None
        </button>
      </div>
      <div style={{ display: "grid", gap: 4 }}>
        {all.map((t) => (
          <label key={t} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={chosen.has(t)}
              disabled={disabled}
              onChange={(e) => toggle(t, e.target.checked)}
            />
            <span className="mono">{t}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

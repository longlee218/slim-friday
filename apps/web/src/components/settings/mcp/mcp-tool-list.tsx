import type { McpProbe } from "./mcp-status";

/** The tool names of a connected server (from the connection test), shown on the server's page. */
export function McpToolList({ probe }: { probe: McpProbe }) {
  const tools = probe.result?.state === "connected" ? (probe.result.tools ?? []) : [];
  if (probe.running || tools.length === 0) return null;
  return (
    <>
      <h3 style={{ fontSize: 13, margin: "16px 0 8px" }}>Tools ({tools.length})</h3>
      <div className="list-panel">
        {tools.map((t) => (
          <div key={t} className="srow">
            <span className="mono grow">{t}</span>
          </div>
        ))}
      </div>
    </>
  );
}

import type { McpCallDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "../../../api/client";
import { useDirectory } from "../../../api/directory";
import { formatClock } from "../../../lib/format";
import { Avatar } from "../../ui/avatar";
import { Pill } from "../../ui/pill";

/** The result pill of a call: allowed (green), asked (grey, with the answer), denied (red). */
function outcomePill(c: McpCallDto) {
  if (c.outcome === "deny") return <Pill tone="red">denied</Pill>;
  if (c.outcome === "ask") return <Pill tone="gray">{c.answer ?? "asked"}</Pill>;
  return <Pill tone="green">allowed</Pill>;
}

/** The server's recent permission decisions, newest first (prototype "Recent calls"). */
export function McpCalls({ server }: { server: string }) {
  const dir = useDirectory();
  const calls = useQuery(orpc.config.mcp.calls.queryOptions({ input: { server, limit: 20 } })).data;
  if (!calls?.length) return null;
  const now = Date.now();
  return (
    <>
      <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>Recent calls</h3>
      <div className="list-panel">
        {[...calls]
          .sort((a, b) => b.at - a.at)
          .map((c) => (
            <div className="srow" key={`${c.at}-${c.botId}-${c.tool}`}>
              <Avatar
                src={dir.bots.get(c.botId)?.avatarUrl}
                name={dir.botName(c.botId)}
                size={22}
              />
              <span className="mono" style={{ flex: 1 }}>
                {c.tool}
              </span>
              {outcomePill(c)}
              <span className="t2 num" style={{ width: 70, textAlign: "right" }}>
                {formatClock(c.at, now)}
              </span>
            </div>
          ))}
      </div>
    </>
  );
}

import type { McpServerDto } from "@friday/contracts";
import { useQuery } from "@tanstack/react-query";
import { Globe, Terminal } from "lucide-react";
import { orpc } from "../../../api/client";

/**
 * An MCP server's tile: the site icon of an http server (found by the engine), else a globe
 * (http) or terminal (stdio) on an orange tile. A stdio server never asks for an icon.
 */
export function McpIcon({ server }: { server: Pick<McpServerDto, "name" | "type"> }) {
  const http = server.type === "http";
  const icon = useQuery({
    ...orpc.config.mcp.icon.queryOptions({ input: { name: server.name } }),
    enabled: http,
    staleTime: Number.POSITIVE_INFINITY,
  }).data?.dataUrl;
  if (icon)
    return (
      <span className="ico site">
        <img src={icon} alt="" />
      </span>
    );
  return (
    <span className="ico orange">
      {http ? <Globe size={16} strokeWidth={1.75} /> : <Terminal size={16} strokeWidth={1.75} />}
    </span>
  );
}

import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Globe, Plus, Terminal } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { orpc } from "../../../api/client";
import { useDirectory } from "../../../api/directory";
import { Avatar } from "../../ui/avatar";
import { Button } from "../../ui/button";
import { Pill } from "../../ui/pill";
import { SettingsPage } from "../settings-page";
import { AddMcpSheet } from "./add-mcp-sheet";
import { useSignInResult } from "./mcp-sign-in";

/** Chip text per OAuth sign-in state. */
const LABEL = { connected: "signed in", needs_login: "needs sign-in", never: "not signed in" };

/** `/settings/mcp`: every MCP server with the bots that use it, and "Add server". */
export function McpList() {
  useSignInResult();
  const dir = useDirectory();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const servers = useQuery(orpc.config.mcp.list.queryOptions()).data ?? [];
  return (
    <SettingsPage
      title="MCP servers"
      // The phone hides the page head, so "Add server" lives in the nav bar there.
      right={
        <button
          type="button"
          className="nb"
          aria-label="Add server"
          onClick={() => setAdding(true)}
        >
          <Plus strokeWidth={1.75} />
        </button>
      }
    >
      <div className="page-head">
        <div className="grow">
          <h2>MCP servers</h2>
          <div className="r">
            Tools from other apps. A bot uses a server only if you turn it on for that bot.
          </div>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={1.75} />
          Add server
        </Button>
      </div>
      <div className="list-panel">
        {servers.map((s) => (
          <Link key={s.name} className="srow" to={`/settings/mcp/${s.name}`}>
            <span className="ico orange">
              {s.type === "http" ? (
                <Globe size={16} strokeWidth={1.75} />
              ) : (
                <Terminal size={16} strokeWidth={1.75} />
              )}
            </span>
            <div className="grow">
              <b>{s.name}</b> <Pill tone="gray">{s.type === "http" ? "http" : "stdio"}</Pill>{" "}
              {s.auth && (
                <Pill tone={s.auth.status === "connected" ? "green" : "amber"}>
                  {LABEL[s.auth.status]}
                </Pill>
              )}
              <div className="t2">
                {s.shipped ? "Shipped" : s.type === "http" ? s.url : s.command}
              </div>
            </div>
            <span className="stack">
              {s.usedBy.map((id) => (
                <Avatar
                  key={id}
                  src={dir.bots.get(id)?.avatarUrl}
                  name={dir.botName(id)}
                  size={20}
                />
              ))}
            </span>
            <ChevronRight size={16} className="chev" />
          </Link>
        ))}
      </div>
      <AddMcpSheet
        open={adding}
        onOpenChange={setAdding}
        onAdded={(name) => void navigate(`/settings/mcp/${name}`)}
      />
    </SettingsPage>
  );
}

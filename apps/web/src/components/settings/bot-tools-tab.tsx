import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Globe, Terminal } from "lucide-react";
import { useState } from "react";
import { orpc } from "../../api/client";
import type { BotTabProps } from "./bot-profile-tab";
import { Row, Switch } from "./form-parts";
import { isServerEntry, serverRef, toolSummary, withoutServer } from "./mcp-tool-entries";
import { McpToolPicker } from "./mcp-tool-picker";
import { TokenList } from "./token-list";

/** Names of the SDK tools and Friday's own tools a bot may be given (annotated in tools.yaml). */
const TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Agent",
  "TodoWrite",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskUpdate",
  "TaskList",
  "TaskStop",
  "mcp__memory",
  "mcp__scratchpad",
  "mcp__chat",
  "mcp__effects",
  "mcp__tickets",
];

/** Tools & skills tab: tool, skill and workspace token lists, and a switch per MCP server. */
export function BotToolsTab({ form, readOnly }: BotTabProps) {
  const { value: v, set } = form;
  const skills = useQuery(orpc.config.skills.list.queryOptions()).data ?? [];
  const servers = useQuery(orpc.config.mcp.list.queryOptions()).data ?? [];
  // Server and per-tool MCP entries are edited by the server rows below, so the tool tokens leave them out.
  const isMcp = (t: string) => servers.some((s) => isServerEntry(t, s.name));
  const shown = v.tools.filter((t) => !isMcp(t));
  const hidden = v.tools.filter(isMcp);
  const toggle = (name: string, on: boolean) =>
    set("tools", on ? [...v.tools, serverRef(name)] : withoutServer(v.tools, name));
  // The server whose tool list is open.
  const [open, setOpen] = useState<string>();

  return (
    <>
      <div className="formgroup">
        <Row
          label="Tools"
          top
          help="Risky tools still ask you before each use, unless you chose “Always allow”."
        >
          <TokenList
            values={shown}
            options={TOOLS}
            addLabel="Add tool"
            disabled={readOnly}
            onChange={(next) => set("tools", [...next, ...hidden])}
          />
        </Row>
        <Row label="Skills" top>
          <TokenList
            values={v.skills}
            options={skills.map((s) => s.name)}
            addLabel="Add skill"
            disabled={readOnly}
            onChange={(next) => set("skills", next)}
          />
        </Row>
        <Row label="Workspaces" top help="Full read and write for this bot.">
          <TokenList
            values={v.workspaces}
            options={[]}
            addLabel="Grant folder"
            placeholder="Type a folder path"
            disabled={readOnly}
            onChange={(next) => set("workspaces", next)}
          />
        </Row>
      </div>
      <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>MCP servers</h3>
      <div className="list-panel">
        {servers.length === 0 && (
          <div className="srow">
            <div className="grow t2">No MCP servers yet.</div>
          </div>
        )}
        {servers.map((s) => {
          const on = v.tools.some((t) => isServerEntry(t, s.name));
          const picking = open === s.name;
          return (
            <div key={s.name}>
              <div className="srow">
                <span className="ico">
                  {s.type === "http" ? (
                    <Globe size={16} strokeWidth={1.75} />
                  ) : (
                    <Terminal size={16} strokeWidth={1.75} />
                  )}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <b>{s.name}</b>
                  <div className="t2">{s.type === "http" ? "HTTP server" : "Local command"}</div>
                </div>
                {on && (
                  <button
                    type="button"
                    className="ib"
                    style={{
                      width: "auto",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 2,
                      padding: "0 6px",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                    aria-label={`Choose tools of ${s.name}`}
                    aria-expanded={picking}
                    onClick={() => setOpen(picking ? undefined : s.name)}
                  >
                    {toolSummary(v.tools, s.name)}{" "}
                    {picking ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                )}
                <Switch
                  label={`Use ${s.name}`}
                  on={on}
                  disabled={readOnly}
                  onChange={(next) => toggle(s.name, next)}
                />
              </div>
              {on && picking && (
                <div className="srow">
                  <div className="grow">
                    <McpToolPicker
                      server={s}
                      entries={v.tools}
                      disabled={readOnly}
                      onChange={(next) => set("tools", next)}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

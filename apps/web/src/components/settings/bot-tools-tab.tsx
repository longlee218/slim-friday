import { useQuery } from "@tanstack/react-query";
import { Globe, Terminal } from "lucide-react";
import { orpc } from "../../api/client";
import type { BotTabProps } from "./bot-profile-tab";
import { Row, Switch } from "./form-parts";
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

/** The tools entry that switches a whole MCP server on. */
const mcpEntry = (name: string) => `mcp__${name}`;

/** Tools & skills tab: tool, skill and workspace token lists, and a switch per MCP server. */
export function BotToolsTab({ form, readOnly }: BotTabProps) {
  const { value: v, set } = form;
  const skills = useQuery(orpc.config.skills.list.queryOptions()).data ?? [];
  const servers = useQuery(orpc.config.mcp.list.queryOptions()).data ?? [];
  const serverEntries = new Set(servers.map((s) => mcpEntry(s.name)));
  // Server entries are edited by the switches below, so the tool tokens leave them out.
  const shown = v.tools.filter((t) => !serverEntries.has(t));
  const hidden = v.tools.filter((t) => serverEntries.has(t));
  const toggle = (name: string, on: boolean) =>
    set("tools", on ? [...v.tools, mcpEntry(name)] : v.tools.filter((t) => t !== mcpEntry(name)));

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
        {servers.map((s) => (
          <div className="srow" key={s.name}>
            <span className="ico">
              {s.type === "http" ? (
                <Globe size={16} strokeWidth={1.75} />
              ) : (
                <Terminal size={16} strokeWidth={1.75} />
              )}
            </span>
            <div className="grow">
              <b>{s.name}</b>
              <div className="t2">{s.type === "http" ? "HTTP server" : "Local command"}</div>
            </div>
            <Switch
              label={`Use ${s.name}`}
              on={v.tools.includes(mcpEntry(s.name))}
              disabled={readOnly}
              onChange={(on) => toggle(s.name, on)}
            />
          </div>
        ))}
      </div>
    </>
  );
}

import { Row, Segmented, Switch } from "../form-parts";
import { KvRows } from "./mcp-kv-rows";
import type { McpFormValue } from "./mcp-spec";

const TYPES = ["Local command", "HTTP"] as const;

/**
 * The connection fields of an MCP server: connection kind, command and arguments or URL, and
 * the environment or header rows. Values are `${NAME}` references to the engine's env, masked
 * with an eye; the server refuses literal secrets and its error shows under the rows.
 */
export function McpForm({
  value,
  errors,
  disabled,
  onChange,
}: {
  value: McpFormValue;
  errors: Partial<Record<keyof McpFormValue, string>>;
  disabled?: boolean;
  onChange<K extends keyof McpFormValue>(k: K, v: McpFormValue[K]): void;
}) {
  const http = value.type === "http";
  // With OAuth on, an Authorization header is not editable (it is dropped on save).
  const isAuth = (p: { k: string }) => value.oauth && p.k.trim().toLowerCase() === "authorization";
  const hidden = value.headers.filter(isAuth);
  const shown = value.headers.filter((p) => !isAuth(p));
  return (
    <>
      <Row label="Connection">
        <Segmented
          label="Connection"
          options={TYPES}
          value={http ? "HTTP" : "Local command"}
          disabled={disabled}
          onChange={(t) => onChange("type", t === "HTTP" ? "http" : "stdio")}
        />
      </Row>
      {http ? (
        <>
          <Row label="URL" htmlFor="mcp-url" error={errors.url}>
            <input
              id="mcp-url"
              className="field mono"
              placeholder="https://mcp.sentry.dev/mcp"
              value={value.url}
              disabled={disabled}
              onChange={(e) => onChange("url", e.target.value)}
            />
          </Row>
          <Row
            label="Sign in with OAuth"
            error={errors.oauth}
            help="Friday signs in once and keeps the login; no token goes in a header."
          >
            <Switch
              label="Sign in with OAuth"
              on={value.oauth}
              disabled={disabled}
              onChange={(on) => onChange("oauth", on)}
            />
          </Row>
          {value.oauth && (
            <Row
              label="Scopes"
              htmlFor="mcp-scopes"
              help="Optional, separated by spaces. Empty uses the server's defaults; offline_access is always added so the login lasts."
            >
              <input
                id="mcp-scopes"
                className="field mono"
                value={value.scopes}
                disabled={disabled}
                onChange={(e) => onChange("scopes", e.target.value)}
              />
            </Row>
          )}
          <Row
            label="Headers"
            top
            error={errors.headers}
            help="Values are ${NAME} references to the host's environment."
          >
            <KvRows
              what="Header"
              rows={shown}
              disabled={disabled}
              onChange={(r) => onChange("headers", [...hidden, ...r])}
            />
          </Row>
        </>
      ) : (
        <>
          <Row label="Command" htmlFor="mcp-command" error={errors.command}>
            <input
              id="mcp-command"
              className="field mono"
              placeholder="npx"
              value={value.command}
              disabled={disabled}
              onChange={(e) => onChange("command", e.target.value)}
            />
          </Row>
          <Row label="Arguments" htmlFor="mcp-args" error={errors.args}>
            <input
              id="mcp-args"
              className="field mono"
              placeholder="@sentry/mcp-server@0.9.1"
              value={value.args}
              disabled={disabled}
              onChange={(e) => onChange("args", e.target.value)}
            />
          </Row>
          <Row
            label="Environment"
            top
            error={errors.env}
            help="Values are ${NAME} references to the host's environment, never shown to bots."
          >
            <KvRows
              what="Variable"
              rows={value.env}
              disabled={disabled}
              onChange={(r) => onChange("env", r)}
            />
          </Row>
        </>
      )}
    </>
  );
}

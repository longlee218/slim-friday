import type { McpServerDto } from "@friday/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { client, orpc } from "../../../api/client";
import { Button } from "../../ui/button";
import { saveFailure } from "../field-error";
import { SaveBar, StaleNotice } from "../form-parts";
import { PhoneRemoveRow } from "../phone-remove-row";
import { SettingsPage } from "../settings-page";
import { useFormState } from "../use-form-state";
import { McpCalls } from "./mcp-calls";
import { McpForm } from "./mcp-form";
import { SignInBanner, useSignInResult } from "./mcp-sign-in";
import { fromServer, toSpec, validateMcp } from "./mcp-spec";
import { ConnBanner, useMcpProbe } from "./mcp-status";
import { McpUsedBy } from "./mcp-used-by";

/** The body of one server: banner, form, switches and calls. Keyed by name so state resets. */
function Loaded({ server }: { server: McpServerDto }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const probe = useMcpProbe();
  const initial = fromServer(server);
  const form = useFormState(initial, validateMcp);
  const readOnly = server.shipped;
  useSignInResult(server.name);
  // Test and sign-in use the saved server, so unsaved URL or OAuth edits are not part of them.
  const untested =
    form.dirty &&
    form.value.type === "http" &&
    (form.value.url !== initial.url || form.value.oauth !== initial.oauth);

  // Test the saved server when the page opens and again after its spec changes.
  const key = JSON.stringify(initial);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `initial`
  useEffect(() => void probe.run(server.name, initial), [server.name, key, probe.run]);

  const retest = () => void probe.run(server.name, initial);
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: orpc.config.mcp.key() }),
      qc.invalidateQueries({ queryKey: orpc.config.bots.key() }),
    ]);
  const save = () =>
    form.submit(async (v) => {
      await client.config.mcp.save({ name: server.name, server: toSpec(v), mode: "update" });
      await refresh();
    });
  const remove = async () => {
    try {
      await client.config.mcp.delete({ name: server.name });
      await refresh();
      void navigate("/settings/mcp", { replace: true });
    } catch (e) {
      // The server refuses while bots use it and names them.
      toast.error(saveFailure(e).message);
    }
  };

  return (
    <SettingsPage title={server.name}>
      <div className="page-head">
        <Link className="ib" to="/settings/mcp" aria-label="Back to servers">
          <ChevronLeft size={16} strokeWidth={1.75} />
        </Link>
        <div className="grow">
          <h2>{server.name}</h2>
          <div className="r">
            {server.type === "http" ? "HTTP server" : "Local command"}
            {readOnly && " · shipped, read only"}
          </div>
        </div>
        {!readOnly && (
          <Button variant="danger" onClick={() => void remove()}>
            <Trash2 size={14} strokeWidth={1.75} />
            Remove
          </Button>
        )}
      </div>
      <SignInBanner server={server} probe={probe} onTest={retest} locked={untested} />
      <ConnBanner probe={probe} errorsOnly={!!server.auth} onTest={retest} />
      {untested && <div className="help">Test and sign-in use the saved settings.</div>}
      <div className="formgroup">
        <McpForm value={form.value} errors={form.errors} disabled={readOnly} onChange={form.set} />
      </div>
      {!readOnly && form.stale && <StaleNotice what="server" />}
      {!readOnly && (
        <SaveBar
          dirty={form.dirty}
          valid={form.valid}
          saving={form.saving}
          onRevert={form.revert}
          onSave={() => void save()}
        />
      )}
      <McpUsedBy name={server.name} usedBy={server.usedBy} />
      <McpCalls server={server.name} />
      {!readOnly && <PhoneRemoveRow label="Remove this server" onClick={() => void remove()} />}
    </SettingsPage>
  );
}

/** `/settings/mcp/:name`: one MCP server. */
export function McpDetail() {
  const { name = "" } = useParams();
  const q = useQuery(orpc.config.mcp.list.queryOptions());
  const server = q.data?.find((s) => s.name === name);
  if (!server) {
    return (
      <SettingsPage title="MCP server">
        <div className="empty">
          <h3>{q.data ? "This server does not exist." : "Loading…"}</h3>
        </div>
      </SettingsPage>
    );
  }
  return <Loaded key={server.name} server={server} />;
}

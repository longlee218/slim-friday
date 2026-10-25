import type { McpServerDto } from "@friday/contracts";
import { CircleCheck, KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { client } from "../../../api/client";
import { formatAge } from "../../../lib/format";
import { Button } from "../../ui/button";
import type { McpProbe } from "./mcp-status";

/** Error toast text per `?signin=<code>` the API callback can send. */
const SIGN_IN_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled",
  expired: "The sign-in link expired, try again",
  failed: "Sign-in failed",
};

/**
 * Reads the `?signin=` result the API callback put on the URL, shows one toast for it, then
 * removes the param so a reload does not repeat the toast. Success lands on the server page
 * (`server` names it); failures land on the list, where no name is known.
 */
export function useSignInResult(server?: string): void {
  const [params, setParams] = useSearchParams();
  const result = params.get("signin");
  useEffect(() => {
    if (!result) return;
    if (result === "ok") toast.success(server ? `Signed in to ${server}` : "Signed in");
    else toast.error(SIGN_IN_ERRORS[result] ?? SIGN_IN_ERRORS.failed ?? "Sign-in failed");
    setParams(
      (p) => {
        p.delete("signin");
        return p;
      },
      { replace: true },
    );
  }, [result, server, setParams]);
}

/** `"just now"` or `"3h ago"`. */
function ago(at: number): string {
  const age = formatAge(at, Date.now());
  return age === "now" ? "just now" : `${age} ago`;
}

/** Banner title per sign-in state (the list chips use the same words). */
const TITLE = { connected: "Signed in", needs_login: "Needs sign-in", never: "Not signed in" };

/**
 * The one status banner of an OAuth server: green when signed in (tool count from the last test,
 * last refresh, **Test again**, **Sign in again**), amber with a primary **Sign in** otherwise.
 * A failed test shows below it in `ConnBanner`. `locked` (unsaved URL or OAuth edits) disables
 * sign-in, which always uses the saved server. Sign in opens the provider's page in this tab.
 */
export function SignInBanner({
  server,
  probe,
  onTest,
  locked,
}: {
  server: McpServerDto;
  probe: McpProbe;
  onTest(): void;
  locked?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  if (!server.auth) return null;
  const { status, lastRefreshAt } = server.auth;
  const ok = status === "connected";
  const signIn = async () => {
    setBusy(true);
    try {
      const { url } = await client.config.mcp.signIn({ name: server.name });
      window.location.assign(url);
    } catch (e) {
      toast.error((e as Error).message || "Sign-in failed");
      setBusy(false);
    }
  };
  const tools = probe.result?.state === "connected" ? probe.result.tools?.length : undefined;
  const details = [
    probe.running ? "testing…" : tools !== undefined && `${tools} tools`,
    lastRefreshAt && `refreshed ${ago(lastRefreshAt)}`,
  ].filter(Boolean);
  return (
    <div className={`conn ${ok ? "ok" : "warn"}`}>
      {ok && probe.running ? (
        <LoaderCircle size={18} className="spin" />
      ) : ok ? (
        <CircleCheck />
      ) : (
        <KeyRound />
      )}
      <div className="grow">
        <b>{TITLE[status]}</b>
        {ok
          ? details.map((d) => ` · ${d}`).join("")
          : ". Bots get an error from this server until you sign in."}
      </div>
      {ok && (
        <Button disabled={probe.running} onClick={onTest}>
          Test again
        </Button>
      )}
      <Button
        variant={ok ? "secondary" : "primary"}
        disabled={busy || locked}
        title={locked ? "Save your changes first" : undefined}
        onClick={() => void signIn()}
      >
        {busy ? "Opening…" : ok ? "Sign in again" : "Sign in"}
      </Button>
    </div>
  );
}

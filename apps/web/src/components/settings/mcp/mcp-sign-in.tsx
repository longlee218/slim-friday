import type { McpServerDto } from "@friday/contracts";
import { CircleCheck, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { client } from "../../../api/client";
import { formatAge } from "../../../lib/format";
import { Button } from "../../ui/button";

/** Error toast text per `?signin=<code>` the API callback can send. */
const SIGN_IN_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled",
  expired: "The sign-in link expired, try again",
  failed: "Sign-in failed",
};

/**
 * Reads the `?signin=` result the API callback put on the URL, shows one toast for it, then
 * removes the param so a reload does not repeat the toast.
 */
export function useSignInResult(server: string): void {
  const [params, setParams] = useSearchParams();
  const result = params.get("signin");
  useEffect(() => {
    if (!result) return;
    if (result === "ok") toast.success(`Signed in to ${server}`);
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

/**
 * The sign-in banner of an OAuth server: green when connected (with the last refresh), amber
 * when it needs a login or has none yet. **Sign in** opens the provider's page in this tab.
 */
export function SignInBanner({ server }: { server: McpServerDto }) {
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
  return (
    <div className={`conn ${ok ? "ok" : "warn"}`}>
      {ok ? <CircleCheck /> : <KeyRound />}
      <div className="grow">
        {ok ? (
          <>
            <b>Connected</b>
            {lastRefreshAt && ` · last refresh ${ago(lastRefreshAt)}`}
          </>
        ) : (
          <b>{status === "never" ? "Not signed in yet" : "Needs sign-in"}</b>
        )}
      </div>
      <Button disabled={busy} onClick={() => void signIn()}>
        Sign in
      </Button>
    </div>
  );
}

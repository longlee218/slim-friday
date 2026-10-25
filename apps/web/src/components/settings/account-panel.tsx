import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { authClient } from "../../api/auth-client";
import { useAppNavigate } from "../shell/use-app-navigate";
import { Button, IconButton } from "../ui/button";
import { SettingsPage } from "./settings-page";

const KEY = ["account", "passkeys"] as const;

/** `/settings/account`: the signed-in email, the passkeys (add, remove) and "Sign out all devices". */
export function AccountPanel() {
  const qc = useQueryClient();
  const navigate = useAppNavigate();
  const session = useQuery({
    queryKey: ["account", "session"],
    queryFn: () => authClient.getSession(),
  });
  const passkeys = useQuery({
    queryKey: KEY,
    queryFn: async () => (await authClient.passkey.listUserPasskeys()).data ?? [],
  });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  /** Runs one auth call; a failure is a toast, a success refreshes the list. */
  async function run(
    call: () => Promise<{ error?: { message?: string } | null } | null | undefined>,
  ) {
    try {
      const res = await call();
      if (res?.error) throw new Error(res.error.message);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "That did not work. Try again.");
    }
  }

  async function signOutAll() {
    try {
      const res = await authClient.revokeSessions();
      if (res?.error) throw new Error(res.error.message);
      navigate("/login");
    } catch {
      toast.error("Could not sign out all devices.");
    }
  }

  return (
    <SettingsPage title="Account">
      <div className="page-head">
        <div className="grow">
          <h2>Account</h2>
          <div className="r">
            Sign-in is passkey only.
            {session.data?.data?.user.email && (
              <>
                {" "}
                Signed in as <b>{session.data.data.user.email}</b>.
              </>
            )}
          </div>
        </div>
      </div>
      <h3 style={{ fontSize: 13, margin: "0 0 8px" }}>Passkeys</h3>
      <div className="list-panel">
        {(passkeys.data ?? []).map((p) => (
          <div className="srow" key={p.id}>
            <span className="ico">
              <Fingerprint size={16} strokeWidth={1.75} />
            </span>
            <div className="grow">
              <b>{p.name || "Passkey"}</b>
              <div className="t2">
                Added{" "}
                {new Date(p.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </div>
            </div>
            <IconButton
              label="Remove"
              onClick={() => void run(() => authClient.passkey.deletePasskey({ id: p.id }))}
            >
              <Trash2 size={16} strokeWidth={1.75} />
            </IconButton>
          </div>
        ))}
        <div className="add-row">
          <span className="grow" />
          <Button onClick={() => void run(() => authClient.passkey.addPasskey())}>
            <Fingerprint size={14} strokeWidth={1.75} />
            Add passkey
          </Button>
        </div>
      </div>
      <div className="list-panel">
        <div className="srow">
          <div className="grow">
            <b>Sign out all devices</b>
            <div className="t2">Ends every session. You sign in again with a passkey.</div>
          </div>
          <Button variant="danger" onClick={() => void signOutAll()}>
            Sign out all
          </Button>
        </div>
      </div>
    </SettingsPage>
  );
}

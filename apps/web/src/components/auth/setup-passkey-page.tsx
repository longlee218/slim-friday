import { Fingerprint, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { authClient } from "../../api/auth-client";
import { Button } from "../ui/button";
import { LoginCard } from "./login-card";

/** `/setup-passkey`: the page the sign-in link opens; registers a passkey for this device. */
export function SetupPasskeyPage() {
  const navigate = useNavigate();
  // better-auth sends an expired or invalid link here with `?error=...`.
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const res = await authClient.passkey.addPasskey();
      if (res?.error) throw new Error(res.error.message);
      navigate("/welcome");
    } catch {
      setError("Could not create the passkey. Try again.");
      setBusy(false);
    }
  }

  if (params.get("error")) {
    return (
      <LoginCard>
        <h1>This link expired. Get a new one.</h1>
        <p>Sign-in links work once and only for a few minutes.</p>
        <Link className="btn primary" to="/login-link">
          Get a sign-in link
        </Link>
      </LoginCard>
    );
  }

  return (
    <LoginCard>
      <h1>Add a passkey</h1>
      <p>Next time you sign in with Face ID or Touch ID. No password.</p>
      <Button variant="primary" disabled={busy} onClick={create}>
        {busy ? <LoaderCircle className="spin" /> : <Fingerprint />}
        {busy ? "Creating…" : "Create passkey"}
      </Button>
      {error && <p role="alert">{error}</p>}
      <div className="note">You can add more devices later in Settings → Account.</div>
    </LoginCard>
  );
}

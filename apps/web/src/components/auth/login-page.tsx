import { Fingerprint, LoaderCircle, Terminal } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { authClient } from "../../api/auth-client";
import { Button } from "../ui/button";
import { LoginCard } from "./login-card";

/** The log line the owner runs on the host to read the link (path from the engine home). */
const TAIL_COMMAND = "tail -n 1 ~/.friday/logs/owner-links.log";

/** Passkey sign-in with a fallback to the host-log link flow. */
export function LoginPage({ step }: { step: "start" | "link" }) {
  return step === "link" ? <LinkStep /> : <StartStep />;
}

/** `/login`: the passkey button and the way to a sign-in link. */
function StartStep() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) throw new Error(res.error.message);
      navigate("/");
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <LoginCard>
      <h1>Sign in to Friday</h1>
      <p>Your bots are waiting.</p>
      <Button variant="primary" disabled={busy} onClick={signIn}>
        {busy ? <LoaderCircle className="spin" /> : <Fingerprint />}
        {busy ? "Waiting for your passkey…" : "Sign in with passkey"}
      </Button>
      {failed && <p role="alert">That didn't work. Try again or get a sign-in link.</p>}
      <div className="alt">
        <Link className="btn" to="/login-link">
          <Terminal />
          Get a sign-in link
        </Link>
      </div>
      <div className="note">
        New device or lost passkey? The sign-in link is written to Friday's log on the host. Only
        someone with access to that machine can use it.
      </div>
    </LoginCard>
  );
}

/** `/login-link`: ask for the link, then point at the host log. */
function LinkStep() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    setError("");
    try {
      const res = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL: `${location.origin}/setup-passkey`,
      });
      if (res?.error) throw new Error(res.error.message);
      setSent(true);
    } catch {
      setError("Could not request a link. Check the address and that Friday is running.");
    }
  }

  return (
    <LoginCard>
      <h1>Check the host</h1>
      {sent ? (
        <>
          <p>
            A sign-in link is in Friday's log on the machine that runs it. Open it on this device.
          </p>
          <pre className="login-log">{TAIL_COMMAND}</pre>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p>
            Enter your email. Friday writes a sign-in link to its log on the machine that runs it.
          </p>
          <input
            className="field login-email"
            type="email"
            placeholder="Your email"
            aria-label="Your email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button variant="primary" type="submit" disabled={!email.trim()}>
            Send link
          </Button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
      <div className="alt">
        <Link className="linkbtn" to="/login">
          Back
        </Link>
      </div>
    </LoginCard>
  );
}

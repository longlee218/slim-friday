import { redirect, useRevalidator } from "react-router";
import { authClient } from "../api/auth-client";
import { LoginCard } from "../components/auth/login-card";
import { Button } from "../components/ui/button";

/** Route loader: no session means the sign-in screen. */
export async function requireSession(): Promise<null> {
  const { data } = await authClient.getSession();
  if (!data) throw redirect("/login");
  return null;
}

/**
 * Route loader of `/login`: a signed-in owner goes to `/`. A failed session check (API
 * unreachable) stays on the sign-in screen, which then fails on its own call.
 */
export async function redirectIfSignedIn(): Promise<null> {
  try {
    const { data } = await authClient.getSession();
    if (data) throw redirect("/");
  } catch (e) {
    if (e instanceof Response) throw e;
  }
  return null;
}

/** Shown while the first session check runs: the empty ground, so there is no flash. */
export function SessionPending() {
  return <div style={{ minHeight: "100dvh", background: "var(--ground)" }} />;
}

/** Shown when the session check itself fails (API unreachable); Retry re-runs the loader. */
export function SessionError() {
  const { revalidate, state } = useRevalidator();
  return (
    <LoginCard>
      <h1>Can't reach Friday.</h1>
      <p>Check that Friday is running and your connection is up.</p>
      <Button variant="primary" disabled={state === "loading"} onClick={() => revalidate()}>
        Retry
      </Button>
    </LoginCard>
  );
}

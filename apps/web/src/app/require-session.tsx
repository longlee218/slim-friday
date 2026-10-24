import { Outlet, redirect, useRevalidator } from "react-router";
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
 * Minimal protected layout: the loader above guards the routes, the children render in the
 * outlet. Task 16's ResponsiveRoot replaces this element.
 */
export function RequireSession() {
  return <Outlet />;
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

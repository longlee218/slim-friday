import { Outlet, redirect } from "react-router";
import { authClient } from "../api/auth-client";

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

import { createBrowserRouter, type RouteObject } from "react-router";
import { setUnauthorizedHandler } from "../api/client";
import { LoginPage } from "../components/auth/login-page";
import { SetupPasskeyPage } from "../components/auth/setup-passkey-page";
import { WelcomePage } from "../components/auth/welcome-page";
import { protectedChildren } from "./protected-routes";
import {
  redirectIfSignedIn,
  requireSession,
  SessionError,
  SessionPending,
} from "./require-session";
import { ResponsiveRoot } from "./responsive-root";

/**
 * Every route path of the app (shared contract "Web routes"). The signed-in ones live in
 * `protected-routes.tsx`; plans 4-5 replace their placeholders and keep the paths.
 */
export const appRoutes: RouteObject[] = [
  { path: "/login", loader: redirectIfSignedIn, element: <LoginPage step="start" /> },
  { path: "/login-link", element: <LoginPage step="link" /> },
  { path: "/setup-passkey", element: <SetupPasskeyPage /> },
  { path: "/welcome", element: <WelcomePage /> },
  {
    loader: requireSession,
    element: <ResponsiveRoot />,
    HydrateFallback: SessionPending,
    errorElement: <SessionError />,
    children: protectedChildren,
  },
];

/** The browser router for the app. */
export const createAppRouter = () => createBrowserRouter(appRoutes);

/** An UNAUTHORIZED rpc reply sends the owner to the sign-in screen. */
export function wireUnauthorized(router: { navigate: (to: string) => unknown }): void {
  setUnauthorizedHandler(() => router.navigate("/login"));
}

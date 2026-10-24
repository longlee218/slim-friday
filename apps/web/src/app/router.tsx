import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { setUnauthorizedHandler } from "../api/client";
import { LoginPage } from "../components/auth/login-page";
import { SetupPasskeyPage } from "../components/auth/setup-passkey-page";
import { WelcomePage } from "../components/auth/welcome-page";
import { RoutePlaceholder } from "../components/shell/route-placeholder";
import { RequireSession, requireSession, SessionError } from "./require-session";

/**
 * Every route path of the app (shared contract "Web routes"). Plans 4-5 replace the
 * placeholder elements and keep the paths.
 */
export const appRoutes: RouteObject[] = [
  { path: "/login", element: <LoginPage step="start" /> },
  { path: "/login-link", element: <LoginPage step="link" /> },
  { path: "/setup-passkey", element: <SetupPasskeyPage /> },
  { path: "/welcome", element: <WelcomePage /> },
  {
    loader: requireSession,
    element: <RequireSession />,
    errorElement: <SessionError />,
    children: [
      // Task 16 adds last-chat memory and the phone Chats list.
      { path: "/", element: <Navigate to="/c/bot:friday" replace /> },
      { path: "/c/:conversationId", element: <RoutePlaceholder title="Chat" /> },
      { path: "/tickets", element: <RoutePlaceholder title="Tickets" /> },
      { path: "/tickets/:ref", element: <RoutePlaceholder title="Ticket" /> },
      { path: "/ops", element: <RoutePlaceholder title="Ops" /> },
      { path: "/settings/*", element: <RoutePlaceholder title="Settings" /> },
    ],
  },
];

/** The browser router for the app. */
export const createAppRouter = () => createBrowserRouter(appRoutes);

/** An UNAUTHORIZED rpc reply sends the owner to the sign-in screen. */
export function wireUnauthorized(router: { navigate: (to: string) => unknown }): void {
  setUnauthorizedHandler(() => router.navigate("/login"));
}

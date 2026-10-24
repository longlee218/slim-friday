import { Component, type ReactNode } from "react";
import { LoginCard } from "../components/auth/login-card";
import { Button } from "../components/ui/button";

/** Generic render-error screen: not the "Can't reach Friday." of the session check. */
export function RouteError() {
  return (
    <LoginCard>
      <h1>Something went wrong.</h1>
      <Button variant="primary" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </LoginCard>
  );
}

/**
 * Error boundary for the phone screens (they render through `useRoutes`, so the routes'
 * `errorElement` does not catch them): shows `RouteError` instead of the session error.
 */
export class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <RouteError /> : this.props.children;
  }
}

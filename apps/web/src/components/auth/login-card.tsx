import type { ReactNode } from "react";

/** Centered card of the sign-in screens (`.login`); the face sits above the content. */
export function LoginCard({ children, face = true }: { children: ReactNode; face?: boolean }) {
  return (
    <div className="login">
      <div className="login-card">
        {face && (
          <span className="av">
            <img src="/avatars/lead.webp" alt="" />
          </span>
        )}
        {children}
      </div>
    </div>
  );
}

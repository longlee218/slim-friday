import type { ReactNode } from "react";

/** One titled block of the inspector. */
export function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="insp-sec">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** A label / value row. */
export const Prop = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="prop">
    <span>{label}</span>
    <span className="num">{children}</span>
  </div>
);

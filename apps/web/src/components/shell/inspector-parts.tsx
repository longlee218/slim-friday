import { ChevronRight } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/** Colour of a section's icon tile (the settings tiles' palette). */
export type TileTone = "blue" | "green" | "orange" | "purple" | "teal" | "gray";

/** One block of the chat info: a header with a coloured icon tile, then grouped rows. */
export function InspectorSection({
  title,
  icon,
  tone = "gray",
  children,
}: {
  title: string;
  icon?: ReactNode;
  tone?: TileTone;
  children: ReactNode;
}) {
  return (
    <div className="insp-sec">
      <h3>
        {icon && <span className={`insp-tile ${tone}`}>{icon}</span>}
        {title}
      </h3>
      {children}
    </div>
  );
}

/** A label / value row; with `onClick` it is a button row with a chevron. */
export function PropLink({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick(): void;
}) {
  return (
    <button type="button" className="prop link" onClick={onClick}>
      <span>{label}</span>
      <span className="num">{children}</span>
      <ChevronRight className="chev" size={15} strokeWidth={1.75} />
    </button>
  );
}

/** A label / value row. */
export const Prop = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="prop">
    <span>{label}</span>
    <span className="num">{children}</span>
  </div>
);

/** Messenger's round quick action: an icon in a circle with its label under it. */
export function QuickAction({
  icon,
  label,
  danger,
  ...rest
}: { icon: ReactNode; label: string; danger?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={danger ? "qa danger" : "qa"} {...rest}>
      <span className="qa-ico">{icon}</span>
      <span className="qa-l">{label}</span>
    </button>
  );
}

import { User } from "lucide-react";

/** Dashed empty face shown for a ticket without an assignee. */
export function UnassignedFace({ size = 24 }: { size?: number }) {
  return (
    <span className="av none" style={{ width: size, height: size }} title="Unassigned">
      <User />
    </span>
  );
}

import { useIsPhone } from "../../app/use-is-phone";

/**
 * The phone's place for a page's Remove action: the page head (and its Remove button) is hidden
 * there, so a red inset row at the end of the page does the same thing (iOS settings style).
 * Renders nothing on desktop.
 */
export function PhoneRemoveRow({ label, onClick }: { label: string; onClick(): void }) {
  const phone = useIsPhone();
  if (!phone) return null;
  return (
    // Settings pages already have 16 px side margins, so the inset adds none of its own.
    <div className="inset" style={{ margin: "22px 0 0" }}>
      <button type="button" className="irow danger" onClick={onClick}>
        <div className="grow" style={{ textAlign: "center" }}>
          {label}
        </div>
      </button>
    </div>
  );
}

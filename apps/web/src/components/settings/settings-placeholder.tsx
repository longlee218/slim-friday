/** Stand-in body of a settings screen a later task builds (the route exists already). */
export function SettingsPlaceholder({ title }: { title: string }) {
  return (
    <div className="empty" style={{ position: "relative" }}>
      <h3>{title} is not built yet.</h3>
    </div>
  );
}

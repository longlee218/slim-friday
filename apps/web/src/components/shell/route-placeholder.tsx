/** Stand-in for a screen a later plan builds: toolbar title plus an empty state. */
export function RoutePlaceholder({ title }: { title: string }) {
  return (
    <section style={{ position: "relative", height: "100%" }}>
      <div className="toolbar">
        <div className="tb-title">
          <h1>{title}</h1>
        </div>
      </div>
      <div className="empty">
        <h3>{title} is not built yet.</h3>
      </div>
    </section>
  );
}

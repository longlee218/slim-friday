import type { ReactNode } from "react";
import { PanelsContext, useResponsivePanels } from "./use-responsive-panels";

export interface AppShellProps {
  sidebar: ReactNode;
  main: ReactNode;
  inspector?: ReactNode;
}

/**
 * Desktop frame: `.mac` grid (sidebar | main | inspector). A panel opened below its band floats
 * over the chat (CSS media rules) and a pointerdown inside the main pane closes it.
 */
export function AppShell({ sidebar, main, inspector }: AppShellProps) {
  const panels = useResponsivePanels();
  const showInspector = inspector !== undefined && panels.inspector.open;
  const cls = ["mac", showInspector && "insp", !panels.sidebar.open && "nosb"]
    .filter(Boolean)
    .join(" ");
  return (
    <PanelsContext.Provider value={panels}>
      <div className={cls} data-mode={panels.mode}>
        <aside className="sidebar" aria-hidden={!panels.sidebar.open} inert={!panels.sidebar.open}>
          {sidebar}
        </aside>
        <main className="main" onPointerDown={panels.closeFloating}>
          <div className="main-vt">{main}</div>
        </main>
        {inspector && (
          <aside
            className="inspector"
            aria-hidden={!panels.inspector.open}
            inert={!panels.inspector.open}
          >
            {inspector}
          </aside>
        )}
      </div>
    </PanelsContext.Provider>
  );
}

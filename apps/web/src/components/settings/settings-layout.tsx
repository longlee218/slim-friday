import { Settings } from "lucide-react";
import { Outlet } from "react-router";
import { useIsPhone } from "../../app/use-is-phone";
import { Toolbar } from "../shell/toolbar";
import { SettingsList } from "./settings-list";

/**
 * Frame of every `/settings/*` route. Desktop: toolbar, the list column and the form pane
 * (prototype `.set`). Phone: just the page, because each page is its own navigation entry.
 */
export function SettingsLayout() {
  if (useIsPhone()) return <Outlet />;
  return (
    <section className="pane">
      <Toolbar
        title={
          <>
            <span className="sb-ico">
              <Settings strokeWidth={1.75} />
            </span>
            <div>
              <h1>Settings</h1>
            </div>
          </>
        }
      />
      <div className="content" style={{ overflow: "hidden" }}>
        <div className="set">
          <SettingsList />
          <div className="set-form">
            <div className="inner">
              <Outlet />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

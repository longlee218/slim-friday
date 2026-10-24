import { useCallback, useState } from "react";
import { matchPath, Outlet, useLocation } from "react-router";
import { PhoneShell } from "../components/phone/phone-shell";
import { AppShell } from "../components/shell/app-shell";
import { Inspector } from "../components/shell/inspector";
import { useNotifier } from "../components/shell/notification-toast";
import { Sidebar } from "../components/shell/sidebar";
import { useTabTitle } from "../components/shell/tab-title";
import { useShortcuts } from "../components/shell/use-shortcuts";
import { useEventStream } from "../events/use-event-stream";
import { protectedChildren } from "./protected-routes";
import { ConnectionContext, PaletteContext } from "./shell-context";
import { useIsPhone } from "./use-is-phone";

/** Keyboard shortcuts need the panels of `AppShell`, so they mount inside its main pane. */
function Shortcuts({ onPalette }: { onPalette: () => void }) {
  useShortcuts({ onPalette });
  return null;
}

/**
 * Layout of every signed-in route. Mounts the app-wide pieces once, above the mode switch so
 * they survive a width crossing: the event stream, the tab title and the palette state. Below
 * 640 px the phone shell renders the routes; above, the desktop shell with sidebar, routed
 * main and (on a chat) the inspector.
 */
export function ResponsiveRoot() {
  const phone = useIsPhone();
  const { pathname } = useLocation();
  const chatId = matchPath("/c/:conversationId", pathname)?.params.conversationId ?? null;
  const notify = useNotifier();
  const connection = useEventStream({ activeConversationId: chatId, notify });
  useTabTitle();
  const [_paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  return (
    <ConnectionContext.Provider value={connection}>
      <PaletteContext.Provider value={openPalette}>
        {phone ? (
          <PhoneShell routes={protectedChildren} />
        ) : (
          <AppShell
            sidebar={<Sidebar onPalette={openPalette} />}
            main={
              <>
                <Shortcuts onPalette={openPalette} />
                <Outlet />
              </>
            }
            inspector={chatId ? <Inspector conversationId={chatId} /> : undefined}
          />
        )}
        {/* Task 17 mounts <CommandPalette open={_paletteOpen} onOpenChange={setPaletteOpen} /> here. */}
      </PaletteContext.Provider>
    </ConnectionContext.Provider>
  );
}

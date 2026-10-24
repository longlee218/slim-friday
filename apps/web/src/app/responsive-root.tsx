import { useCallback, useEffect, useState } from "react";
import { matchPath, Outlet, useLocation } from "react-router";
import { PhoneShell } from "../components/phone/phone-shell";
import { AppShell } from "../components/shell/app-shell";
import { CommandPalette } from "../components/shell/command-palette";
import { Inspector } from "../components/shell/inspector";
import { navHistory } from "../components/shell/nav-history";
import { useNotifier } from "../components/shell/notification-toast";
import { Sidebar } from "../components/shell/sidebar";
import { useTabTitle } from "../components/shell/tab-title";
import { useAppNavigate } from "../components/shell/use-app-navigate";
import { useShortcuts } from "../components/shell/use-shortcuts";
import { NewTicketSheet } from "../components/tickets/new-ticket-sheet";
import { TicketDrawer } from "../components/tickets/ticket-drawer";
import { useSelectedTicket, useSelectTicket } from "../components/tickets/use-ticket-selection";
import { useEventStream } from "../events/use-event-stream";
import { protectedChildren } from "./protected-routes";
import { ConnectionContext, NewTicketContext, PaletteContext } from "./shell-context";
import { useIsPhone } from "./use-is-phone";

/** Notify callback of the phone: nothing. */
const NO_NOTIFY = () => {};

/** Keyboard shortcuts need the panels of `AppShell`, so they mount inside its main pane. */
function Shortcuts({ onPalette }: { onPalette: () => void }) {
  const selected = useSelectedTicket();
  const select = useSelectTicket();
  useShortcuts({
    onPalette,
    // Esc closes an open ticket drawer, unless the owner is typing (keep the draft).
    onEscape: () => {
      const el = document.activeElement;
      if (!selected || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        return false;
      select(null);
      return true;
    },
  });
  return null;
}

/** Drawer of the ticket picked on the board; closing clears the pick from the URL. */
function DrawerSlot({ ticketRef }: { ticketRef: string }) {
  const select = useSelectTicket();
  return <TicketDrawer ticketRef={ticketRef} onClose={() => select(null)} />;
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
  // Keep the window-style history (back/forward, last chat) aligned with the URL on both layouts.
  useEffect(() => navHistory.sync(pathname), [pathname]);
  const notify = useNotifier();
  // Toasts are desktop only; the phone shows badges. The stream reads notify through a ref.
  const connection = useEventStream({
    activeConversationId: chatId,
    notify: phone ? NO_NOTIFY : notify,
  });
  useTabTitle();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const [newTicketOpen, setNewTicketOpen] = useState(false);
  const openNewTicket = useCallback(() => setNewTicketOpen(true), []);
  const ticketRef = useSelectedTicket();
  const go = useAppNavigate();
  // The new ticket shows on the board (and, on desktop, opens its drawer).
  const newTicketSheet = (
    <NewTicketSheet
      open={newTicketOpen}
      onOpenChange={setNewTicketOpen}
      onCreated={(t) => go(phone ? "/tickets" : `/tickets?t=${t.ref}`)}
    />
  );

  return (
    <ConnectionContext.Provider value={connection}>
      <PaletteContext.Provider value={openPalette}>
        <NewTicketContext.Provider value={openNewTicket}>
          {phone ? (
            <>
              <PhoneShell routes={protectedChildren} />
              {newTicketSheet}
            </>
          ) : (
            <AppShell
              sidebar={<Sidebar onPalette={openPalette} />}
              main={
                <>
                  <Shortcuts onPalette={openPalette} />
                  <Outlet />
                  {newTicketSheet}
                </>
              }
              inspector={
                chatId ? (
                  <Inspector conversationId={chatId} />
                ) : ticketRef ? (
                  <DrawerSlot ticketRef={ticketRef} />
                ) : undefined
              }
            />
          )}
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} asSheet={phone} />
        </NewTicketContext.Provider>
      </PaletteContext.Provider>
    </ConnectionContext.Provider>
  );
}

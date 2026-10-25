import { Link, Navigate, type RouteObject } from "react-router";
import { ActivityRoute } from "../components/activity/activity-route";
import { ChatView } from "../components/chat/chat-view";
import { ChatsList } from "../components/phone/chats-list";
import { PhoneChat } from "../components/phone/phone-chat";
import { SchedulePageRoute } from "../components/schedules/schedule-page-route";
import { SchedulesRoute } from "../components/schedules/schedules-route";
import { settingsRoutes } from "../components/settings/settings-routes";
import { navHistory } from "../components/shell/nav-history";
import { TicketPageRoute } from "../components/tickets/ticket-page-route";
import { TicketsRoute } from "../components/tickets/tickets-route";
import { RouteError } from "./route-error";
import { useConnection } from "./shell-context";
import { useIsPhone } from "./use-is-phone";

/** `/c/:conversationId`: the desktop chat, or the phone chat below 640 px. */
function ChatRoute() {
  const phone = useIsPhone();
  const connection = useConnection();
  return phone ? <PhoneChat /> : <ChatView connection={connection} />;
}

/** `/`: the Chats list on the phone; on desktop it opens the last visited chat. */
function HomeRoute() {
  return useIsPhone() ? <ChatsList /> : <Navigate to={navHistory.lastChat} replace />;
}

/** Any other path: a small not-found page (not the session error). */
function NotFound() {
  return (
    <div className="empty" style={{ position: "relative", height: "100%" }}>
      <h3>Nothing here.</h3>
      <Link to="/" className="linkbtn">
        Go to Chats
      </Link>
    </div>
  );
}

/**
 * Routes of the signed-in app. `ResponsiveRoot` renders them in its outlet on desktop and
 * through `PhoneShell` (one per stack entry) on the phone. Each has its own error element, so
 * a render bug is not labelled as a session failure.
 */
export const protectedChildren: RouteObject[] = [
  { path: "/", element: <HomeRoute /> },
  { path: "/c/:conversationId", element: <ChatRoute /> },
  { path: "/tickets", element: <TicketsRoute /> },
  { path: "/tickets/:ref", element: <TicketPageRoute /> },
  { path: "/schedules", element: <SchedulesRoute /> },
  { path: "/schedules/:id", element: <SchedulePageRoute /> },
  { path: "/ops", element: <ActivityRoute /> },
  ...settingsRoutes,
  { path: "*", element: <NotFound /> },
].map((r) => ({ ...r, errorElement: <RouteError /> }));

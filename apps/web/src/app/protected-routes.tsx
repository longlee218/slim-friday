import { Link, Navigate, type RouteObject } from "react-router";
import { ChatView } from "../components/chat/chat-view";
import { ChatsList } from "../components/phone/chats-list";
import { PhoneChat } from "../components/phone/phone-chat";
import { PhonePlaceholder } from "../components/phone/phone-placeholder";
import { navHistory } from "../components/shell/nav-history";
import { RoutePlaceholder } from "../components/shell/route-placeholder";
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

/** Placeholder of a screen a later plan builds, in the layout of the current mode. */
function Placeholder({ title }: { title: string }) {
  return useIsPhone() ? <PhonePlaceholder title={title} /> : <RoutePlaceholder title={title} />;
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
  { path: "/tickets", element: <Placeholder title="Tickets" /> },
  { path: "/tickets/:ref", element: <Placeholder title="Ticket" /> },
  { path: "/ops", element: <Placeholder title="Ops" /> },
  { path: "/settings/*", element: <Placeholder title="Settings" /> },
  { path: "*", element: <NotFound /> },
].map((r) => ({ ...r, errorElement: <RouteError /> }));

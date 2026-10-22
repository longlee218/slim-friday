import "@fontsource/be-vietnam-pro/400.css";
import "@fontsource/be-vietnam-pro/500.css";
import "@fontsource/be-vietnam-pro/600.css";
import "@fontsource/be-vietnam-pro/700.css";
import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/app-shell";
import { ChatProvider } from "./chat/chat-store";
import "./styles/tokens.css";
import "./styles/window.css";
import "./styles/conversation.css";
import "./styles/parts.css";
import "./styles/decisions.css";
import "./styles/media.css";
import "./styles/inspector.css";
import "./styles/forms.css";
import "./styles/actions.css";
import "./styles/responsive.css";
import "./styles/motion.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    {/* Honors the OS "reduce motion" setting for every motion component. */}
    <MotionConfig reducedMotion="user">
      <ChatProvider>
        <AppShell />
      </ChatProvider>
    </MotionConfig>
  </StrictMode>,
);

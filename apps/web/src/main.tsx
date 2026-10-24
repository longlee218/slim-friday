import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/app.css";

// Placeholder shell; the router and providers arrive in later tasks.
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <div>Friday</div>
  </StrictMode>,
);

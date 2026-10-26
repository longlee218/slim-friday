import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "sonner";
import { queryClient } from "./api/query-client";
import { blockPinchZoom } from "./app/block-pinch-zoom";
import { registerAppUpdate } from "./app/register-app-update";
import { createAppRouter, wireUnauthorized } from "./app/router";
import "./styles/app.css";

const router = createAppRouter();
wireUnauthorized(router);
registerAppUpdate();
blockPinchZoom();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" offset={18} />
    </QueryClientProvider>
  </StrictMode>,
);

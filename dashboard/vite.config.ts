import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Dev: Vite serves the UI on 5173 and proxies /api to the read-only Bun server (server/server.ts). */
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4318" },
  },
});

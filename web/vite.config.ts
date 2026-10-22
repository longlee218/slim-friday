import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Friday web app: dev server on localhost only (the agent API will be local too).
// Installable PWA: the service worker precaches the app shell (JS, CSS, fonts, avatars)
// and updates itself in the background when a new build is deployed.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/apple-touch-icon.png"],
      manifest: {
        name: "Friday",
        short_name: "Friday",
        description: "Chat with your AI teammates.",
        lang: "en",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#fbfaf7",
        theme_color: "#fbfaf7",
        icons: [
          { src: "icons/pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,webp,png,svg}"],
        // Icons are large PNGs; keep the default 2 MB cap but make room for them.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  server: { host: "127.0.0.1", port: 5173 },
  // Production preview, reached through the Cloudflare Tunnel `friday`.
  preview: { host: "127.0.0.1", port: 4173, allowedHosts: ["friday-ui.example.com"] },
});

import type { VitePWAOptions } from "vite-plugin-pwa";

// Installable app shell only. The API lives on another origin (VITE_API_URL) and file
// URLs are presigned, so nothing but the built assets is ever cached.
export const pwaOptions: Partial<VitePWAOptions> = {
  registerType: "autoUpdate",
  manifest: {
    name: "Friday",
    short_name: "Friday",
    display: "standalone",
    start_url: "/",
    scope: "/",
    background_color: "#f2f2f6",
    theme_color: "#f4f4f7",
    icons: [
      { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
      { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
      { src: "pwa-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
  workbox: {
    globPatterns: ["**/*.{js,css,html,svg,png,webp,woff2}"],
    // Lazy shiki/mermaid chunks (see vite.config.ts) are fetched on demand, not precached.
    globIgnores: ["**/assets/lazy/**"],
    navigateFallback: "/index.html",
    // Never serve the app shell for API calls.
    navigateFallbackDenylist: [/^\/rpc/, /^\/api\//],
    runtimeCaching: [],
  },
};

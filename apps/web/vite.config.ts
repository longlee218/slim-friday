import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// PWA plugin is added in the PWA task.
export default defineConfig({ plugins: [react(), tailwindcss()] });

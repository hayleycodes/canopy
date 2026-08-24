import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ports are env-driven so you can run several instances at once, one per
// workspace. CANOPY_PORT picks the API server to proxy to; CANOPY_WEB_PORT
// picks this dev server's port (Vite auto-increments if it's taken).
const apiPort = process.env.CANOPY_PORT || 8787;
const webPort = Number(process.env.CANOPY_WEB_PORT) || 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    port: webPort,
    proxy: {
      // Proxy /api through Vite so the browser only talks to one origin in dev.
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
  // Same proxy for `vite preview` (the built app), so a no-hot-reload build can
  // reach the API on one origin too.
  preview: {
    port: webPort,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});

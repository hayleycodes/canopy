import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Front end on :5173, API on :8787. Proxy /api through Vite so the browser only
// ever talks to one origin in dev.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});

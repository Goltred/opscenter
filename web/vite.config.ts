import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy API + SSE + metrics to the control plane so the SPA is
// same-origin (avoids CORS and keeps the session cookie first-party).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      "/metrics": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});

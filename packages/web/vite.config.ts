import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` proxies the API to a running `anchorx-ray` (default port 3000).
const api = process.env["ANCHORX_RAY_API"] ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2048 },
  server: { proxy: { "/api": { target: api, changeOrigin: true } } },
});

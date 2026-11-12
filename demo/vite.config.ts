import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    port: 5173,
    host: process.env.VITE_HOST ?? "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});

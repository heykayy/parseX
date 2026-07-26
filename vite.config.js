import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Dev server config
  server: {
    port: 5173,   // frontend runs here
    // Proxy /api calls to your Express server during development
    // This means in ParseX.jsx you can just write fetch("/api/claude")
    // instead of fetch("http://localhost:3001/api/claude")
    // Both work — the proxy just makes it cleaner
    proxy: {
      "/api": {
        // Replace with your actual Render backend URL, e.g.
        target: "https://your-backend.onrender.com",
        changeOrigin: true,
      },
    },
  },

  // Preview server (used when you run "npm run preview" after building)
  preview: {
    port: 4173,
  },

  // Build output goes into /dist — this is what Vercel deploys
  build: {
    outDir: "dist",
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react(), {
    name: "build-revision",
    transformIndexHtml: () => [{
      tag: "meta",
      attrs: { name: "vkbablo-build", content: process.env.GITHUB_SHA || "local" },
      injectTo: "head",
    }],
  }],
  base: process.env.GITHUB_PAGES === "true" ? "/VKBablo/" : "/",
  // Explicit Safari syntax baseline rather than Vite's moving browser default.
  build: { target: ["es2020", "safari15"], cssTarget: "safari15" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
  },
});

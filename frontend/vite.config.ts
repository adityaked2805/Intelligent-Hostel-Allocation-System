import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: {
    proxy: {
      "/auth": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/admin": {
        target: "http://localhost:3000",
        changeOrigin: true,
        bypass: (req) => {
          // Allow React Router to handle page navigation to /admin
          // Only proxy API calls to /admin/*
          if (req.url === "/admin" && req.method === "GET") {
            return "/admin"; // Don't proxy, let React Router handle it
          }
          return undefined; // Proxy to backend
        },
      },
      "/groups": {
        target: "http://localhost:3000",
        changeOrigin: true,
        bypass: (req) => {
          if (req.url === "/groups" && req.method === "GET") {
            return "/groups";
          }
          return undefined;
        },
      },
      "/students": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/allocation-data": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/swaps": {
        target: "http://localhost:3000",
        changeOrigin: true,
        bypass: (req) => {
          // Allow React Router to handle page navigation to /swaps
          // Only proxy API calls to /swaps/*
          if (req.url === "/swaps" && req.method === "GET") {
            return "/swaps"; // Don't proxy, let React Router handle it
          }
          return undefined; // Proxy to backend
        },
      },
      "/roommate-invitations": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Connect requests are POST /<package>.<Service>/<Method> — proxy the
      // whole service to the backend so the browser client can use a
      // same-origin baseUrl and needs no CORS setup on the server.
      "/acme.user.v1.UserService": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});

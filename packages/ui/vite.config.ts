import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.AGYHQ_API_URL || env.VITE_AGYHQ_API_URL || "http://127.0.0.1:7317";
  return {
    // Absolute: the daemon serves the SPA at / and deep links (/tasks/:id) must still find /assets/*.
    base: "/",
    plugins: [react()],
    server: {
      proxy: {
        "/v1": {
          target,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: true,
    },
  };
});

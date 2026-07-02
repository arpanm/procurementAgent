/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  build: {
    // Split the stable third-party libraries into their own `vendor` chunk, separate from app code, so
    // the previous ~1.4 MB monolith becomes an app chunk (~180 kB) + a cacheable vendor chunk. A single
    // vendor bucket (rather than react/ionic split) avoids the React↔Ionic circular-chunk warning.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) return "vendor";
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // Vitest owns the jsdom unit/component tests under src/. The Playwright e2e specs live in ./e2e
    // and are run by `npm run test:e2e`; keep the two runners from picking up each other's files.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/core/**/*.ts"],
    },
  },
});

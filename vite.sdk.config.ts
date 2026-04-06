import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, "src/sdk/sdk.ts"),
      name: "BundleLLM",
      formats: ["iife"],
      fileName: () => "sdk.js",
    },
    outDir: "dist-sdk",
    emptyOutDir: true,
    minify: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
});

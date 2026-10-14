import { defineConfig } from "vite";

// Vite only bundles the frontend; Django serves the page. The bundle lands in the
// galaxy app's static folder under fixed names, so the template can reference it
// with {% static %} and Django's manifest storage adds the cache-busting hashes.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "galaxy/static/galaxy/dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 800, // three.js alone is ~550 kB
    rolldownOptions: {
      input: "src/main.ts",
      output: {
        entryFileNames: "app.js",
        chunkFileNames: "[name].js",
        assetFileNames: "app[extname]",
      },
    },
  },
});

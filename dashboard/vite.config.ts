import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // This repo lives in an iCloud-synced folder on some machines. iCloud
    // drops "<name> 2.<ext>" conflict copies next to real files and re-touches
    // them constantly; without this the dev server full-reloads the page
    // every minute or so and can keep a tab from ever painting.
    watch: { ignored: ["**/* 2.*", "**/node_modules/**"] },
  },
});

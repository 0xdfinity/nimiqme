import { defineConfig } from "vite"

export default defineConfig({
  base: "/app/",
  server: { port: 5173, host: true },
  build: { target: "es2020", outDir: "dist" },
})

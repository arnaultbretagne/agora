import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// In development, the API is the server's (TEST_ROUTES or not): AGORA_SERVER=http://<server>:8080.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  server: { proxy: { '/api': { target: process.env.AGORA_SERVER ?? 'http://127.0.0.1:8080', changeOrigin: true } } },
  // Fonts stay files: the server's policy (font-src 'self') refuses data: URIs.
  build: { assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined) },
})

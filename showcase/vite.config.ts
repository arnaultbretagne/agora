import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  // Les polices restent des fichiers : la CSP servie (font-src 'self') refuse les data: URI.
  build: { assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined) },
})

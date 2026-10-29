import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// A static page served from any path (base './'), under a policy of 'self' only: fonts stay files
// (no data: URIs), and every chunk stays well under a ConfigMap's 1 MiB.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  build: {
    assetsInlineLimit: (file) => (file.endsWith('.woff2') || file.endsWith('.woff') ? false : undefined),
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'assistant-ui', test: /node_modules[\\/]@assistant-ui[\\/]/ },
            { name: 'markdown', test: /node_modules[\\/](react-markdown|remark-|micromark|mdast-|hast-|unified|unist-|vfile|property-information|decode-named|character-|ccount|comma-|space-sep|zwitch|longest-streak|markdown-table|devlop|bail|trough|is-plain-obj|html-url|estree|trim-lines)/ },
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
})

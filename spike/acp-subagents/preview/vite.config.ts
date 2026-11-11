// The preview: a static page that renders Agora's own client components (apps/web/src, unmodified) on
// data folded from captured ACP lines. Two build-time seams, no source change: the components' one
// import of the live connection (agora/runtime.tsx) resolves to a static stand-in; shell.tsx's `Item`
// and `Title`, which it does not export, are exported. Served from any path (base './'), under a
// 'self'-only policy: fonts stay files, every chunk well under a ConfigMap's 1 MiB.
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const WEB = path.resolve(import.meta.dirname, '../../../apps/web/src')
const STANDIN = path.resolve(import.meta.dirname, 'src/standin.tsx')

const seams: Plugin = {
  name: 'agora-seams',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer?.startsWith(WEB) && /(^|\/)agora\/runtime\.tsx$/.test(source)) return STANDIN
    return null
  },
  transform(code, id) {
    if (id === path.join(WEB, 'screen/shell.tsx')) return `${code}\nexport { Item, Title, Below }\n`
    return null
  },
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [seams, react(), tailwindcss()],
  resolve: { alias: { '@': WEB } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: (file) => (file.endsWith('.woff2') || file.endsWith('.woff') ? false : undefined),
    chunkSizeWarningLimit: 900,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'assistant-ui', test: /node_modules[\\/]@assistant-ui[\\/]/ },
            { name: 'markdown', test: /node_modules[\\/](react-markdown|remark-|micromark|mdast-|hast-|unified|unist-|vfile|property-information|decode-named|character-|ccount|comma-|space-sep|zwitch|longest-streak|markdown-table|devlop|bail|trough|is-plain-obj|html-url|estree|trim-lines|shiki|@shikijs)/ },
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
})

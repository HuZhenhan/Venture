import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const isElectronTarget = mode === 'electron'

  return {
    base: './',
    plugins: [
      figmaAssetResolver(),
      react(),
      tailwindcss(),
      viteSingleFile(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: isElectronTarget ? 5174 : 5173,
      strictPort: true,
    },
    build: {
      outDir: 'dist/web',
      emptyOutDir: true,
    },
    define: {
      __IS_ELECTRON__: isElectronTarget,
    },
    assetsInclude: ['**/*.svg', '**/*.csv'],
  }
})

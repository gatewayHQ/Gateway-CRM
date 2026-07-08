import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks: {
          // React core — cached by browsers indefinitely between deploys
          'vendor-react':     ['react', 'react-dom'],
          // Supabase client — large but shared across all pages
          'vendor-supabase':  ['@supabase/supabase-js'],
          // Anthropic SDK — only pages using AI generation need this
          'vendor-anthropic': ['@anthropic-ai/sdk'],
        },
      },
    },
  },
})

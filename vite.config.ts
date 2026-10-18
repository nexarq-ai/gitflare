import { existsSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// demo.gitflare.io must run the published open-source code, never the hosted tree
if (process.env.CLOUDFLARE_ENV === 'demo' && existsSync('src/worker/hosted-signin.ts')) throw new Error('The demo builds from the self-hosted export. Run npm run build:demo.');

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
});

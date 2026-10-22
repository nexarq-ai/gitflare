import { existsSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';

// demo.gitflare.io must run the published open-source code, never the hosted tree
if (process.env.CLOUDFLARE_ENV === 'demo' && existsSync('src/worker/hosted-signin.ts')) throw new Error('The demo builds from the self-hosted export. Run npm run build:demo.');

export const KUMO_PRIMARY_BUTTON_SELECTOR = '.bg-\\(--kumo-button-emphasis-bg\\)';

export function requireKumoStyles(): Plugin {
  return {
    name: 'gitflare:require-kumo-styles',
    apply: 'build',
    generateBundle(_options, bundle) {
      const styles = Object.values(bundle).flatMap((file) => file.type === 'asset' && file.fileName.endsWith('.css') ? [String(file.source)] : []);
      if (styles.length && !styles.some((css) => css.includes(KUMO_PRIMARY_BUTTON_SELECTOR))) this.error(`Built CSS lacks Kumo component styles (${KUMO_PRIMARY_BUTTON_SELECTOR}). Install dependencies in this tree so the Kumo @source in src/ui/styles.css resolves.`);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), requireKumoStyles()],
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
});

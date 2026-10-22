import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { ROUTE_MODULES_MARKER, ROUTE_MODULE_SOURCES, type RouteModuleName, type RouteModules } from './src/shared/route-modules';

// demo.gitflare.io must run the published open-source code, never the hosted tree
if (process.env.CLOUDFLARE_ENV === 'demo' && existsSync('src/worker/hosted-signin.ts')) throw new Error('The demo builds from the self-hosted export. Run npm run build:demo.');

export const KUMO_PRIMARY_BUTTON_SELECTOR = '.bg-\\(--kumo-button-emphasis-bg\\)';
export const KUMO_SOURCES_FILE = 'node_modules/.gitflare/kumo-sources.css';

export function requireKumoStyles(): Plugin {
  return {
    name: 'gitflare:require-kumo-styles',
    apply: 'build',
    generateBundle(_options, bundle) {
      const styles = Object.values(bundle).flatMap((file) => file.type === 'asset' && file.fileName.endsWith('.css') ? [String(file.source)] : []);
      if (styles.length && !styles.some((css) => css.includes(KUMO_PRIMARY_BUTTON_SELECTOR))) this.error(`Built CSS lacks Kumo component styles (${KUMO_PRIMARY_BUTTON_SELECTOR}). Install dependencies in this tree so the Kumo @source in ${KUMO_SOURCES_FILE} resolves.`);
    },
  };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function kumoComponentFiles(sourceRoot = 'src', dist = resolve('node_modules/@cloudflare/kumo/dist')): string[] {
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file) || !existsSync(file)) return;
    files.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)) visit(resolve(dirname(file), match[1]!));
  };
  for (const file of sourceFiles(sourceRoot)) for (const match of readFileSync(file, 'utf8').matchAll(/["']@cloudflare\/kumo\/components\/([\w-]+)["']/g)) visit(join(dist, 'components', `${match[1]}.js`));
  return [...files].sort();
}

export function kumoSources(): Plugin {
  return {
    name: 'gitflare:kumo-sources',
    config() {
      mkdirSync(dirname(KUMO_SOURCES_FILE), { recursive: true });
      writeFileSync(KUMO_SOURCES_FILE, kumoComponentFiles().map((file) => `@source ${JSON.stringify(file)};\n`).join(''));
    },
  };
}

export function routeModules(): Plugin {
  return {
    name: 'gitflare:route-modules',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!bundle) return html;
        const chunks = Object.values(bundle).flatMap((file) => file.type === 'chunk' ? [file] : []);
        const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
        const entry = chunks.find((chunk) => chunk.isEntry);
        const closure = (start: string[]) => {
          const seen = new Set<string>();
          const visit = (file: string) => { if (seen.has(file) || !byFile.has(file)) return; seen.add(file); byFile.get(file)!.imports.forEach(visit); };
          start.forEach(visit);
          return seen;
        };
        const loaded = entry ? closure([entry.fileName]) : new Set<string>();
        const modules: RouteModules = {};
        for (const [name, source] of Object.entries(ROUTE_MODULE_SOURCES) as [RouteModuleName, string][]) {
          const chunk = chunks.find((item) => item.facadeModuleId === resolve(source));
          if (!chunk) continue;
          const files = [...closure([chunk.fileName])].filter((file) => !loaded.has(file));
          const css = new Set(files.flatMap((file) => [...(byFile.get(file)!.viteMetadata?.importedCss ?? [])]));
          for (const file of loaded) for (const sheet of byFile.get(file)!.viteMetadata?.importedCss ?? []) css.delete(sheet);
          modules[name] = { js: files.map((file) => `/${file}`), css: [...css].map((file) => `/${file}`) };
        }
        if (!modules.public) return html;
        return html.replace('</body>', `<!--${ROUTE_MODULES_MARKER}${JSON.stringify(modules)}-->\n</body>`);
      },
    },
  };
}

export default defineConfig({
  plugins: [kumoSources(), react(), tailwindcss(), cloudflare(), requireKumoStyles(), routeModules()],
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
});

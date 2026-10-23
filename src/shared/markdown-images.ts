import { publicRepositoryPath } from './handles';

export const RAW_IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
};

export const RAW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export function isDeployBadgeSource(src?: string | null): boolean {
  if (!src) return false;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && url.hostname === 'deploy.workers.cloudflare.com' && url.pathname === '/button';
  } catch { return false; }
}

export function rawImageType(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(RAW_IMAGE_TYPES, extension) ? RAW_IMAGE_TYPES[extension] : undefined;
}

export function rawImagePath(handle: string, repository: string, commitSha: string, path: string): string {
  return `${publicRepositoryPath(handle, repository)}/-/raw/${commitSha}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

export function resolveRepositoryPath(target: string, from: string): string | null {
  if (!target || target.startsWith('#') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  try {
    const url = new URL(target, `https://repository.invalid/${from}`);
    if (url.origin !== 'https://repository.invalid') return null;
    return decodeURIComponent(url.pathname.slice(1));
  } catch { return null; }
}

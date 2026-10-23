import type { AppEnv } from './env';
export function publicPageResponse(_request: Request, _env: AppEnv): Response | null { return null; }
export function sitePageHead(_request: Request, _env: AppEnv): { tags: string; structured: string } { return { tags: '', structured: '' }; }
export async function sitemapResponse(_request: Request, _env: AppEnv, _ctx?: unknown): Promise<Response | null> { return null; }

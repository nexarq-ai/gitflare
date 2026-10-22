import { HANDLE_PATTERN } from '../shared/handles';
import { RAW_IMAGE_MAX_BYTES, rawImageType } from '../shared/markdown-images';
import { repositoryPath } from './domain';
import type { AppEnv } from './env';
import { PROXIED_IMAGE_HEADERS } from './image-proxy';
import { resolvePublicRepository } from './public-repositories';
import { clientIp, consume, rateLimitedResponse } from './rate-limits';
import { securityClient } from './security';

const RAW_PATH = /^\/([^/]+)\/([^/]+)\/-\/raw\/([a-f0-9]{40})\/(.+)$/;

function refusal(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { ...PROXIED_IMAGE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function rawImageResponse(request: Request, env: AppEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const match = RAW_PATH.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return refusal(405, 'Method not allowed');
  let handle: string, name: string, path: string;
  try {
    handle = decodeURIComponent(match[1]!).toLowerCase();
    name = decodeURIComponent(match[2]!);
    path = repositoryPath(match[4]!.split('/').map(decodeURIComponent).join('/'), false);
  } catch { return refusal(404, 'Not found'); }
  const sha = match[3]!;
  const type = rawImageType(path);
  if (!type) return refusal(415, 'Only image files are served from this address.');
  if (!HANDLE_PATTERN.test(handle) || !env.GITFLARE_SECURITY || !env.ARTIFACTS) return refusal(404, 'Not found');
  const limited = await consume(env, 'PUBLIC_READ_RATE_LIMIT', `ip:${clientIp(request)}`);
  if (limited) return rateLimitedResponse(limited, 'public repository requests');
  const target = await resolvePublicRepository(env, securityClient(env), handle, name).catch(() => null);
  if (!target) return refusal(404, 'Not found');
  if ('redirect' in target) return new Response(null, { status: 308, headers: { Location: `/${target.redirect}/${match[2]}/-/raw/${sha}/${match[4]}`, 'Cache-Control': 'no-store' } });
  using source = await env.ARTIFACTS.get(target.repository.name);
  const blob = await source.readFile({ ref: sha, path }).catch(() => null);
  if (!blob) return refusal(404, 'Not found');
  if (blob.size > RAW_IMAGE_MAX_BYTES) return refusal(413, 'The image is larger than 5 MB.');
  return new Response(request.method === 'HEAD' ? null : await blob.arrayBuffer(), { headers: { ...PROXIED_IMAGE_HEADERS, 'Content-Type': type, 'Cache-Control': 'public, max-age=300' } });
}

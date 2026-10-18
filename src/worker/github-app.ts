import { Buffer } from 'node:buffer';
import { ApiError } from './domain';

export interface GitHubAppConfig { appId: string; privateKey: string; slug?: string }
export interface GitHubAppEnv { GITHUB_APP_ID?: string; GITHUB_APP_PRIVATE_KEY?: string; GITHUB_APP_SLUG?: string }

const API = 'https://api.github.com';

export function githubAppConfig(env: GitHubAppEnv): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID?.trim(), privateKey = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKey || !/^\d{1,12}$/.test(appId)) return null;
  const slug = env.GITHUB_APP_SLUG?.trim();
  return { appId, privateKey, ...(slug && /^[a-z0-9-]{1,100}$/.test(slug) ? { slug } : {}) };
}

export function githubAppInstallUrl(config: GitHubAppConfig | null): string | undefined {
  return config?.slug ? `https://github.com/apps/${config.slug}/installations/new` : undefined;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, content: Buffer): Buffer { return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]); }

const RSA_ALGORITHM = Buffer.from('300d06092a864886f70d0101010500', 'hex');

export function pkcs8Der(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, '\n'));
  if (!match || !!match[1] !== !!match[3]) throw new ApiError(503, 'GITHUB_APP_MISCONFIGURED', 'GITHUB_APP_PRIVATE_KEY is not a PEM private key.');
  const body = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!match[1]) return new Uint8Array(body);
  return new Uint8Array(der(0x30, Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, body)])));
}

const base64url = (value: Uint8Array | string) => Buffer.from(value).toString('base64url');

export async function githubAppJwt(config: GitHubAppConfig, nowMs = Date.now()): Promise<string> {
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey('pkcs8', pkcs8Der(config.privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(503, 'GITHUB_APP_MISCONFIGURED', 'GITHUB_APP_PRIVATE_KEY could not be loaded as an RSA key.'); }
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }))}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${base64url(signature)}`;
}

export async function githubInstallationToken(config: GitHubAppConfig, installationId: number, repository: string, fetcher: typeof fetch = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetcher(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${await githubAppJwt(config)}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'gitflare-mirror', 'x-github-api-version': '2022-11-28' },
      body: JSON.stringify({ repositories: [repository], permissions: { contents: 'write' } }),
    });
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(502, 'MIRROR_UNREACHABLE', 'GitHub could not be reached.'); }
  const body = await response.json().catch(() => ({})) as { token?: unknown };
  if (response.status === 404 || response.status === 422) throw new ApiError(422, 'GITHUB_APP_INSTALLATION_REJECTED', 'The GitHub App installation does not exist or cannot write to this repository. Install the App on the repository with Contents read and write.');
  if (response.status === 401 || response.status === 403) throw new ApiError(503, 'GITHUB_APP_MISCONFIGURED', 'GitHub rejected the App credentials. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.');
  if (!response.ok || typeof body.token !== 'string' || !body.token) throw new ApiError(502, 'MIRROR_UNAVAILABLE', `GitHub returned HTTP ${response.status} for the installation token.`);
  return body.token;
}

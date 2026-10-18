import OAuthProvider, { AuthorizationError, getOAuthApi, OAuthError, type OAuthHelpers, type OAuthProviderOptions } from '@cloudflare/workers-oauth-provider';
import type { AppEnv } from './env';
import { ApiError, publicError } from './domain';
import { securityClient, type Principal } from './security';
import { ACCESS_HEADER, ACCESS_LABELS, ACCESS_LEVELS, accessFromScopes, allows, CLIENT_ACCESS_TOKEN_SECONDS, CLIENT_GRANT_SECONDS, grantedScopes, isAccessLevel, SUPPORTED_SCOPES } from './client-access';

type Authenticate = (request: Request, env: AppEnv, bearerOnly?: boolean) => Promise<Principal>;
type Handler = { fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> };
const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const signedOut = (error: unknown) => [401, 403].includes(publicError(error).status);
const WEB_CALLBACK = ['http:', 'https:'];
// Any local app can claim a private-use scheme, so only known MCP client callbacks are accepted
const PRIVATE_USE_CALLBACKS = [/^cursor:\/\/anysphere\.cursor-mcp\/oauth\/callback$/, /^cursor:\/\/anysphere\.cursor-retrieval\/oauth\/[\w.-]+\/callback$/];
const acceptedCallback = (redirectUri: string) => WEB_CALLBACK.includes(new URL(redirectUri).protocol) || PRIVATE_USE_CALLBACKS.some(pattern => pattern.test(redirectUri));

function page(body: string, headers = new Headers(), validatedRedirectUri?: string): Response {
  const callback = validatedRedirectUri ? new URL(validatedRedirectUri) : undefined;
  const callbackSource = !callback ? '' : WEB_CALLBACK.includes(callback.protocol) ? ` ${callback.origin}` : ` ${callback.protocol}`;
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin');
  headers.set('Content-Security-Policy', `default-src 'none'; font-src 'self'; style-src 'unsafe-inline'; form-action 'self'${callbackSource}; frame-ancestors 'none'; base-uri 'none'`);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect to Gitflare</title><style>
@font-face{font-family:Instrument Sans;src:url(/fonts/instrument-sans-latin-wght-normal.woff2) format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}html{color-scheme:dark}body{margin:0;background:#08090b;color:#eceef1;font:14px/1.6 Instrument Sans,system-ui,sans-serif;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:40px 20px}
.connection{width:100%;max-width:440px}.brand{display:flex;align-items:center;justify-content:center;gap:9px;margin-bottom:26px;font-size:23px;font-weight:650;letter-spacing:-.7px}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #32343a;border-radius:8px;background:#181a1f;color:#f6821f}.brand-mark svg{width:21px;height:21px}
main{padding:30px;background:#111317;border:1px solid #282a30;border-radius:12px;box-shadow:0 16px 48px #0003;min-width:0}.eyebrow{display:flex;align-items:center;gap:7px;color:#f6a564;font-size:10px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;margin:0 0 15px}.eyebrow:before{content:"";width:5px;height:5px;background:#f6821f;border-radius:50%}
h1{margin:0 0 12px;font-size:25px;line-height:1.2;letter-spacing:-.7px;font-weight:600;overflow-wrap:anywhere}p{margin:0 0 16px;color:#a7abb4}strong{color:#eceef1;font-weight:550;overflow-wrap:anywhere}a{color:inherit;text-underline-offset:3px}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:10px 16px;border:1px solid #373a42;border-radius:999px;background:#1a1c22;color:#eceef1;font:600 13px/1.4 Instrument Sans,system-ui,sans-serif;cursor:pointer;text-decoration:none;text-align:center}button:hover,.button:hover{background:#252830;border-color:#50545e}.primary,button[value=approve]{background:#f3f4f6;border-color:#f3f4f6;color:#14161a}.primary:hover,button[value=approve]:hover{background:#fff;border-color:#fff}.actions{display:flex;gap:10px;margin-top:24px}.actions>*{flex:1;min-width:0}.signin-actions{flex-direction:column}.signin-note{margin:10px 0 0;font-size:12px;color:#858b96;text-align:center}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid #f6a564;outline-offset:4px}
fieldset{border:0;padding:0;margin:24px 0 16px;min-width:0}legend{font-size:12px;font-weight:600;color:#d4d7dd;padding:0;margin-bottom:10px}.access-choice{display:flex;align-items:flex-start;gap:11px;padding:12px;border:1px solid #2c2f36;border-radius:7px;margin-bottom:8px;cursor:pointer}.access-choice:hover{background:#181b21}.access-choice:has(input:checked){background:#1b1d23;border-color:#717783}.access-choice:focus-within{border-color:#f6a564}.access-choice input{accent-color:#f3f4f6;width:16px;height:16px;margin:3px 0 0;flex-shrink:0}.access-choice strong{display:block;font-size:13px}.access-choice small{display:block;margin-top:3px;font-size:12px;line-height:1.5;color:#9ba1ac}small{color:#9ba1ac}.workspace-details{padding:12px 14px;border:1px solid #2c2f36;border-radius:7px;font-size:12px;line-height:1.8}.consent-note{font-size:12px;line-height:1.6;margin-bottom:0}footer{display:flex;justify-content:center;gap:22px;margin-top:22px;font-size:12px;color:#858b96}footer a{text-decoration:none;padding:4px 0}footer a:hover{color:#eceef1;text-decoration:underline}
@media(max-width:480px){body{padding:24px 16px}main{padding:24px}.brand{margin-bottom:22px}h1{font-size:24px}.actions{flex-wrap:wrap}.actions>*{flex-basis:130px}.signin-actions>*{flex-basis:auto}}
</style></head><body><div class="connection"><div class="brand"><span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M6 7.5v9M18 7.5v1a4 4 0 0 1-4 4h-4a4 4 0 0 0-4 4"/></svg></span><span>Gitflare</span></div><main><p class="eyebrow">Connect your AI client</p>${body}</main><footer aria-label="Gitflare policies and support"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/support">Support</a></footer></div></body></html>`, { headers });
}

function sameSiteHop(request: Request): Response {
  const url = new URL(request.url);
  const target = escape(`${url.pathname}${url.search}`);
  return page(`<meta http-equiv="refresh" content="0;url=${target}"><h1>Checking your Gitflare sign-in…</h1><p><a class="button primary" href="${target}">Continue</a></p>`);
}

function accessChoices(ceiling: (typeof ACCESS_LEVELS)[number]): string {
  return ACCESS_LEVELS.filter(level => allows(ceiling, level)).map(level => `<label class="access-choice"><input type="radio" name="access" value="${level}"${level === ceiling ? ' checked' : ''} required><span><strong>${ACCESS_LABELS[level].title}</strong><small>${ACCESS_LABELS[level].detail}</small></span></label>`).join('');
}

export async function oauthConsent(request: Request, env: AppEnv, authenticate: Authenticate): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) throw new ApiError(503, 'OAUTH_NOT_CONFIGURED', 'MCP browser authorization is not configured.');
  let principal: Principal;
  try { principal = await authenticate(request, env); } catch (error) {
    if (publicError(error).status !== 401 || request.method !== 'GET') throw error;
    await oauth.parseAuthRequest(request);
    // SameSite=Strict session cookies are withheld on cross-site navigations; a same-origin reload sends them
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return sameSiteHop(request);
    const back = new URL(request.url); const signin = `/signin?return=${encodeURIComponent(back.pathname + back.search)}`;
    return page(`<h1>Sign in to connect</h1><p>Connect your AI client to your Gitflare workspace. Sign in and you’ll return here to choose its access.</p><div class="actions signin-actions"><a class="button primary" href="${signin}">Sign in to Gitflare</a></div><p class="signin-note">You’ll review permissions before connecting.</p>`);
  }
  if (principal.credentialId) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Task credentials cannot authorize personal AI clients.');
  try {
    if (request.method === 'GET') {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!authRequest.codeChallenge || authRequest.codeChallengeMethod !== 'S256') throw new ApiError(400, 'PKCE_REQUIRED', 'This client must use OAuth PKCE with S256.');
      const details = await oauth.describeConsent(authRequest);
      if (!acceptedCallback(details.redirectUri)) return page('<h1>Connection could not continue</h1><p>This client asked to return to an app link Gitflare does not accept. Use a client callback with https or a loopback address.</p><p>Restart the connection from your AI client.</p>');
      const transaction = await oauth.beginConsent(authRequest);
      const workspace = await securityClient(env).workspace(principal);
      const ceiling = accessFromScopes(authRequest.scope) ?? 'admin';
      return page(`<h1>Connect ${escape(details.clientName)}?</h1><p>${details.clientDomain ? `Published by <strong>${escape(details.clientDomain)}</strong>.` : 'This client’s name is self-reported and has not been verified.'}</p><p>Access returns to <strong>${escape(details.redirectHost)}</strong>.</p>${details.redirectIsLoopback || !WEB_CALLBACK.includes(new URL(details.redirectUri).protocol) ? '<p>Only continue if you started this connection from an app on your computer.</p>' : ''}<p class="workspace-details">Workspace: <strong>${escape(workspace.name)}</strong><br>Role: <strong>${escape(principal.role)}</strong></p><form method="post"><input type="hidden" name="handle" value="${escape(transaction.handle)}"><fieldset><legend>Allow this client to</legend>${accessChoices(ceiling)}</fieldset><p class="consent-note"><small>Your workspace role still limits every action. The connection lasts up to 30 days of use and ends when you revoke its session in Settings → Access → Account, or when your membership changes.</small></p><div class="actions"><button name="decision" value="approve">Allow connection</button><button name="decision" value="deny" formnovalidate>Cancel</button></div></form>`, transaction.headers, details.redirectUri);
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new ApiError(403, 'ORIGIN_REJECTED', 'Submit authorization from this Gitflare installation.');
    if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new ApiError(415, 'INVALID_CONTENT_TYPE', 'Use the authorization form.');
    const encoded = await request.text();
    if (encoded.length > 8192) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The authorization form is too large.');
    const form = new URLSearchParams(encoded);
    const handle = String(form.get('handle') ?? '');
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(request, handle);
    const access = form.get('access');
    if (!isAccessLevel(access) || !allows(accessFromScopes(approved.request.scope) ?? 'admin', access)) return page('<h1>Connection could not continue</h1><p>Choose one of the offered access levels.</p><p>Restart the connection from your AI client.</p>');
    const scope = grantedScopes(access);
    const client = (await oauth.lookupClient(approved.request.clientId))?.clientName?.trim() || approved.request.clientId;
    const service = securityClient(env);
    const session = principal.bootstrap ? { token: await service.legacySession(), session: undefined } : await service.clientSession(principal, client, CLIENT_GRANT_SECONDS * 1000);
    if (!session || typeof session.token !== 'string') throw new ApiError(503, 'SESSION_FAILED', 'The client session could not be created.');
    const { redirectTo } = await oauth.completeAuthorization({ request: { ...approved.request, scope }, userId: principal.userId, metadata: { workspaceId: principal.workspaceId, sessionId: session.session?.id, client, access }, scope, props: { token: session.token, workspaceId: principal.workspaceId } });
    approved.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return page(`<h1>Connection could not continue</h1><p>${escape(error.description)}</p><p>Restart the connection from your AI client.</p>`);
    throw error;
  }
}

function providerOptions(origin: string, handler: Handler, authenticate: Authenticate): OAuthProviderOptions<AppEnv> {
  return {
    apiRoute: '/mcp',
    apiHandler: { async fetch(request, env, ctx) {
      const props = ctx.props as { token?: unknown; workspaceId?: unknown; external?: unknown };
      if (typeof props.token !== 'string' || typeof props.workspaceId !== 'string') throw new ApiError(401, 'AUTH_REQUIRED', 'Reconnect your client.');
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${props.token}`);
      headers.set('X-Gitflare-Workspace', props.workspaceId);
      headers.delete('Cookie');
      if (props.external === true) headers.delete(ACCESS_HEADER);
      else headers.set(ACCESS_HEADER, accessFromScopes((ctx as { auth?: { scope?: string[] } }).auth?.scope ?? []) ?? 'read');
      return handler.fetch(new Request(request, { headers }), env, ctx);
    } },
    defaultHandler: handler,
    authorizeEndpoint: '/oauth/authorize', tokenEndpoint: '/oauth/token', clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: SUPPORTED_SCOPES, requiredScopes: grantedScopes('admin'),
    accessTokenTTL: CLIENT_ACCESS_TOKEN_SECONDS, refreshTokenTTL: CLIENT_GRANT_SECONDS,
    clientIdMetadataDocumentEnabled: true,
    allowPrivateUseRedirectUris: true,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Gitflare', authorization_servers: [origin] },
    async tokenExchangeCallback({ grantType, props, env }) {
      if (grantType !== 'refresh_token') return;
      const { token, workspaceId } = (props ?? {}) as { token?: unknown; workspaceId?: unknown };
      if (typeof token !== 'string') throw new OAuthError('invalid_grant', { description: 'Reconnect the client.' });
      try { await securityClient(env).authenticate(token, typeof workspaceId === 'string' ? workspaceId : undefined); }
      catch (error) { if (signedOut(error)) throw new OAuthError('invalid_grant', { description: 'This connection was revoked or expired. Reconnect the client.' }); throw error; }
    },
    async resolveExternalToken({ token, request, env }) {
      try { const principal = await authenticate(request, env, true); return { props: { token, workspaceId: principal.workspaceId, external: true }, audience: `${origin}/mcp` }; }
      catch (error) { if (signedOut(error)) return null; throw error; }
    },
  };
}

export function oauthProvider(origin: string, handler: Handler, authenticate: Authenticate) {
  return new OAuthProvider<AppEnv>(providerOptions(origin, handler, authenticate));
}

export async function revokeClientGrants(env: AppEnv, origin: string, handler: Handler, authenticate: Authenticate, userId: string, sessionId: string): Promise<number> {
  if (!env.OAUTH_KV) return 0;
  const helpers = getOAuthApi(providerOptions(origin, handler, authenticate), env);
  let cursor: string | undefined; let revoked = 0;
  do {
    const listing = await helpers.listUserGrants(userId, { limit: 100, cursor });
    for (const grant of listing.items) if ((grant.metadata as { sessionId?: unknown } | null)?.sessionId === sessionId) { await helpers.revokeGrant(grant.id, userId); revoked++; }
    cursor = listing.cursor;
  } while (cursor);
  return revoked;
}

export type { OAuthHelpers };


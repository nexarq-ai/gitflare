export const SECRETS_STORE_READ_SCOPE = 'secrets-store.read';
export const SECRETS_STORE_WRITE_SCOPE = 'secrets-store.write';

export function secretsStoreScopes(env: { CLOUDFLARE_SECRETS_SCOPES?: string }): string[] {
  return (env.CLOUDFLARE_SECRETS_SCOPES ?? `${SECRETS_STORE_READ_SCOPE} ${SECRETS_STORE_WRITE_SCOPE}`).split(/\s+/).filter(Boolean);
}

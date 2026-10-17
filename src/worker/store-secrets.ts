export const STORE_SECRET_BINDINGS = { CLOUDFLARE_CLIENT_SECRET: 'CLOUDFLARE_CLIENT_SECRET_STORE' } as const;
export const STORE_SECRET_TTL_MS = 5 * 60_000;

type SecretName = keyof typeof STORE_SECRET_BINDINGS;
interface StoreSecret { get(): Promise<string> }
const cache = new Map<SecretName, { value: string; expires: number }>();

function storeBinding(value: unknown): StoreSecret | null {
  return value && typeof (value as StoreSecret).get === 'function' ? value as StoreSecret : null;
}

async function storeValue(name: SecretName, binding: StoreSecret, now: number): Promise<string | null> {
  const cached = cache.get(name);
  if (cached && cached.expires > now) return cached.value;
  try {
    const value = (await binding.get()).trim();
    if (!value) return null;
    cache.set(name, { value, expires: now + STORE_SECRET_TTL_MS });
    return value;
  } catch {
    console.error(JSON.stringify({ event: 'secrets_store.read_failed', binding: STORE_SECRET_BINDINGS[name] }));
    return null;
  }
}

export async function withStoreSecrets<E extends object>(env: E, now = Date.now()): Promise<E> {
  const record = env as Record<string, unknown>;
  let resolved: Record<string, unknown> | null = null;
  for (const [name, bindingName] of Object.entries(STORE_SECRET_BINDINGS) as [SecretName, string][]) {
    const binding = storeBinding(record[bindingName]);
    if (!binding) continue;
    const value = await storeValue(name, binding, now);
    if (value && value !== record[name]) (resolved ??= { ...record })[name] = value;
  }
  return (resolved ?? env) as E;
}

export function clearStoreSecretCache(): void { cache.clear(); }

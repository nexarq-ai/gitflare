import { SecurityService, type SecurityOptions, type SecurityPeer } from '../src/worker/security';

type Calls = { transaction: number; list: number; get: number; put: number; delete: number; putBytes: number };
type ListOptions = { prefix: string; start?: string; reverse?: boolean; limit?: number };

function memoryStorage(values: Map<string, unknown>, calls: Calls, hooks: { beforeCommit?: () => void } = {}) {
  let current = values;
  let pending: Promise<unknown> = Promise.resolve();
  return {
    values: () => current,
    transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> {
      const next = pending.then(async () => {
        calls.transaction++;
        const draft = structuredClone(current); let wrote = false;
        const result = await operation({
          get: async (key: string) => { calls.get++; return structuredClone(draft.get(key)); },
          put: async (key: string, value: unknown) => { calls.put++; calls.putBytes += JSON.stringify(value).length; wrote = true; draft.set(key, structuredClone(value)); },
          delete: async (key: string) => { calls.delete++; wrote = true; return draft.delete(key); },
          list: async ({ prefix, start, reverse, limit }: ListOptions) => {
            calls.list++;
            let entries = [...draft].filter(([key]) => key.startsWith(prefix) && (start === undefined || key >= start)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
            if (reverse) entries.reverse();
            if (limit !== undefined) entries = entries.slice(0, limit);
            return new Map(entries.map(([key, value]) => [key, structuredClone(value)]));
          },
        });
        if (wrote) hooks.beforeCommit?.();
        current = draft;
        return result;
      });
      pending = next.catch(() => {});
      return next;
    },
  };
}

export function securityHarness(options: SecurityOptions = {}, seed: Record<string, unknown> = {}) {
  const calls: Calls = { transaction: 0, list: 0, get: 0, put: 0, delete: 0, putBytes: 0 };
  const failures = new Map<string, number>();
  const storages = new Map<string, ReturnType<typeof memoryStorage>>();
  const storage = (name: string) => {
    let found = storages.get(name);
    if (!found) {
      found = memoryStorage(new Map(name === 'security' ? Object.entries(structuredClone(seed)) : []), calls, { beforeCommit: () => { const remaining = failures.get(name) ?? 0; if (remaining > 0) { failures.set(name, remaining - 1); throw new Error(`Injected storage failure in ${name}`); } } });
      storages.set(name, found);
    }
    return found;
  };
  let instances = new Map<string, SecurityService>();
  const resolve = (name: string): SecurityPeer & SecurityService => {
    let instance = instances.get(name);
    if (!instance) { instance = new SecurityService(storage(name) as unknown as Pick<DurableObjectStorage, 'transaction'>, options, resolve); instances.set(name, instance); }
    return instance as SecurityPeer & SecurityService;
  };
  const restart = () => { instances = new Map(); return resolve('security'); };
  const service = resolve('security');
  const records = () => new Map([...storages].flatMap(([name, store]) => [...store.values()].map(([key, value]) => [name === 'security' ? key : `${name}#${key}`, structuredClone(value)] as [string, unknown])));
  const keys = (name: string, prefix = '') => [...storage(name).values().keys()].filter(key => key.startsWith(prefix));
  return { service, restart, calls, records, keys, storages, failNextWrite: (name: string, times = 1) => failures.set(name, times), namespace: { getByName: resolve } };
}

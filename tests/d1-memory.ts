import { DatabaseSync } from 'node:sqlite';

type Value = string | number | null;
type Statement = { sql: string; params: Value[]; bind(...values: Value[]): Statement; all<T>(): Promise<{ results: T[]; success: true; meta: object }>; first<T>(): Promise<T | null>; run(): Promise<{ success: true; meta: { changes: number } }> };

export function memoryD1(): D1Database & { sqlite: DatabaseSync; statements: string[] } {
  const sqlite = new DatabaseSync(':memory:');
  const statements: string[] = [];
  const execute = (sql: string) => { statements.push(sql); return sqlite.prepare(sql); };
  const statement = (sql: string, params: Value[] = []): Statement => ({
    sql, params,
    bind: (...values: Value[]) => statement(sql, values),
    all: async <T>() => ({ results: execute(sql).all(...params) as T[], success: true as const, meta: {} }),
    first: async <T>() => (execute(sql).get(...params) as T | undefined) ?? null,
    run: async () => ({ success: true as const, meta: { changes: Number(execute(sql).run(...params).changes) } }),
  });
  const database = {
    sqlite, statements,
    prepare: (sql: string) => statement(sql),
    batch: async (list: Statement[]) => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of list) results.push(/^\s*select/i.test(item.sql) ? await item.all() : await item.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    exec: async (sql: string) => { sqlite.exec(sql); return { count: 1, duration: 0 }; },
  };
  return database as unknown as D1Database & { sqlite: DatabaseSync; statements: string[] };
}

export function memoryCache() {
  const entries = new Map<string, Response>();
  const calls = { match: 0, put: 0, delete: 0 };
  const cache = {
    match: async (request: Request) => { calls.match++; const found = entries.get(request.url); return found ? found.clone() : undefined; },
    put: async (request: Request, response: Response) => { calls.put++; entries.set(request.url, new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })); },
    delete: async (request: Request) => { calls.delete++; return entries.delete(request.url); },
  };
  return { cache: cache as unknown as Cache, entries, calls };
}

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import type { CloudflareCall, CloudflareCallInit } from '../src/worker/cloudflare-deploy';
import { ApiError } from '../src/worker/domain';
import { applyD1Migrations, compareMigrationNames, createMigrationsTableQuery, migrationDatabases, migrationQuery, normalizeSqlLineEndings, readMigrationFiles, type D1MigrationSet } from '../src/worker/d1-migrations';

const accountId = 'a'.repeat(32);
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function d1(db: DatabaseSync, log: string[] = []): CloudflareCall {
  return (async (path: string, init: CloudflareCallInit = {}) => {
    log.push(`${init.method ?? 'GET'} ${path}`);
    if (path === `/accounts/${accountId}/d1/database`) return [{ uuid: 'found-id', name: 'prahari-db' }];
    const sql = String((init.json as { sql: string }).sql);
    if (/^\s*SELECT/i.test(sql)) return [{ success: true, results: db.prepare(sql).all() }];
    try { db.exec(`BEGIN; ${sql}; COMMIT;`); }
    catch (error) { db.exec('ROLLBACK'); throw new ApiError(502, 'CLOUDFLARE_DEPLOY_REJECTED', `Cloudflare rejected POST /d1/database/x/query: ${(error as Error).message}`); }
    return [{ success: true, results: [] }];
  }) as CloudflareCall;
}

const set = (files: D1MigrationSet['files'], extra: Partial<D1MigrationSet> = {}): D1MigrationSet => ({ binding: 'DB', databaseName: 'prahari-db', databaseId: 'db-id', directory: 'apps/api/migrations', table: 'd1_migrations', files, ...extra });

describe('D1 migrations compatible with wrangler', () => {
  it('reads migrations_dir entries and rejects unsupported layouts', () => {
    expect(migrationDatabases([{ binding: 'DB', database_name: 'prahari-db', database_id: 'id', migrations_dir: 'apps/api/migrations' }, { binding: 'CACHE', database_name: 'cache' }])).toEqual([{ binding: 'DB', databaseName: 'prahari-db', databaseId: 'id', directory: 'apps/api/migrations', table: 'd1_migrations' }]);
    expect(() => migrationDatabases([{ binding: 'DB', database_name: 'x', migrations_dir: 'm', migrations_pattern: 'm/*/migration.sql' }])).toThrow('migrations_pattern');
    expect(() => migrationDatabases([{ binding: 'DB', database_name: 'x', migrations_dir: '../outside' }])).toThrow('outside');
    expect(() => migrationDatabases([{ binding: 'DB', database_name: 'x', migrations_dir: 'm', migrations_table: 'bad name' }])).toThrow('migrations_table');
  });

  it('orders files the way wrangler does and builds the same statements', () => {
    expect(['10_b.sql', '0002_a.sql', 'x.sql', '0001_z.sql', '2_a.sql'].sort(compareMigrationNames)).toEqual(['0001_z.sql', '0002_a.sql', '2_a.sql', '10_b.sql', 'x.sql']);
    expect(createMigrationsTableQuery('d1_migrations')).toContain('CREATE TABLE IF NOT EXISTS "d1_migrations"(\n\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname       TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n);');
    expect(migrationQuery({ name: "0001_it's.sql", sql: 'SELECT 1;' }, 'd1_migrations')).toBe(`SELECT 1;\nINSERT INTO "d1_migrations" (name)\nvalues ('0001_it''s.sql');`);
    expect(normalizeSqlLineEndings("a\r\nb 'x\r\ny' -- c\r\nd")).toBe("a\nb 'x\r\ny' -- c\nd");
  });

  it('applies each pending file once, in order, and agrees with an existing wrangler table', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(createMigrationsTableQuery('d1_migrations'));
    db.exec("INSERT INTO d1_migrations (name) VALUES ('0000_init.sql')");
    db.exec('CREATE TABLE tickets(id INTEGER)');
    const files = [{ name: '0000_init.sql', sql: 'CREATE TABLE tickets(id INTEGER);' }, { name: '0001_add.sql', sql: 'ALTER TABLE tickets ADD COLUMN title TEXT;' }, { name: '0002_seed.sql', sql: "INSERT INTO tickets VALUES (1, 'a');" }];
    const progress: string[][] = [];
    const evidence = await applyD1Migrations(d1(db), accountId, set(files), async (item) => { progress.push([...item.applied]); });
    expect(evidence).toMatchObject({ databaseId: 'db-id', pending: ['0001_add.sql', '0002_seed.sql'], applied: ['0001_add.sql', '0002_seed.sql'] });
    expect(progress).toEqual([['0001_add.sql'], ['0001_add.sql', '0002_seed.sql']]);
    expect((db.prepare('SELECT name FROM d1_migrations ORDER BY id').all() as { name: string }[]).map((row) => row.name)).toEqual(['0000_init.sql', '0001_add.sql', '0002_seed.sql']);
    expect(await applyD1Migrations(d1(db), accountId, set(files))).toMatchObject({ pending: [], applied: [] });
    db.close();
  });

  it('stops on the first failing file, records it and leaves later files unapplied', async () => {
    const db = new DatabaseSync(':memory:');
    const files = [{ name: '0000_ok.sql', sql: 'CREATE TABLE a(id);' }, { name: '0001_bad.sql', sql: 'CREATE TABLE a(id);' }, { name: '0002_never.sql', sql: 'CREATE TABLE b(id);' }];
    let last: unknown;
    await expect(applyD1Migrations(d1(db), accountId, set(files), async (item) => { last = structuredClone(item); })).rejects.toMatchObject({ code: 'D1_MIGRATION_FAILED' });
    expect(last).toMatchObject({ applied: ['0000_ok.sql'], failed: { name: '0001_bad.sql' } });
    expect((db.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((row) => row.name)).toEqual(['0000_ok.sql']);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all()).toEqual([]);
    db.close();
  });

  it('looks up a database by name when the config has no id', async () => {
    const db = new DatabaseSync(':memory:');
    const log: string[] = [];
    const evidence = await applyD1Migrations(d1(db, log), accountId, set([], { databaseId: undefined }));
    expect(evidence.databaseId).toBe('found-id');
    expect(log[0]).toBe(`GET /accounts/${accountId}/d1/database`);
    db.close();
  });

  it('reads migration files from the sandbox working tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitflare-d1-'));
    roots.push(root);
    mkdirSync(join(root, 'apps/api/migrations'), { recursive: true });
    writeFileSync(join(root, 'apps/api/migrations/0001_b.sql'), 'B;');
    writeFileSync(join(root, 'apps/api/migrations/0000_a.sql'), 'A;');
    writeFileSync(join(root, 'apps/api/migrations/notes.md'), 'skip');
    const sandbox = { collect: async (script: string) => { const result = spawnSync('bash', ['-c', script], { cwd: root, encoding: 'utf8' }); return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }; } };
    const sets = await readMigrationFiles(sandbox, migrationDatabases([{ binding: 'DB', database_name: 'prahari-db', migrations_dir: 'apps/api/migrations' }]));
    expect(sets[0].files).toEqual([{ name: '0000_a.sql', sql: 'A;' }, { name: '0001_b.sql', sql: 'B;' }]);
    await expect(readMigrationFiles(sandbox, migrationDatabases([{ binding: 'DB', database_name: 'x', migrations_dir: 'missing' }]))).rejects.toMatchObject({ code: 'D1_MIGRATIONS_DIRECTORY_MISSING' });
  });
});

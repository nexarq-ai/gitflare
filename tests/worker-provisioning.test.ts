import { describe, expect, it } from 'vitest';
import type { CloudflareCall, CloudflareCallInit } from '../src/worker/cloudflare-deploy';
import { WorkerBuildFailure } from '../src/worker/worker-bundle';
import { SCRIPT_UPLOAD_QUERY, applyTriggers, currentMigrationTag, ensureResources, metadataBindings, requiredDeployScopes, scriptMetadata, type WorkerDeployConfig } from '../src/worker/worker-provisioning';

const ACCOUNT = 'e3820ad86f4c966e305a6ae3b91bfe35';
const ZONE = 'a'.repeat(32);
const D1_ID = 'e5aec431-6c88-4454-afac-7cf26941d158';

const prahariApi: WorkerDeployConfig = {
  name: 'prahari-api',
  main: 'src/index.ts',
  compatibility_date: '2026-07-01',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: false,
  observability: { enabled: true },
  d1_databases: [{ binding: 'DB', database_name: 'prahari-db', database_id: D1_ID, migrations_dir: 'migrations' }],
  durable_objects: { bindings: [{ name: 'TICKET_DO', class_name: 'TicketDO' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['TicketDO'] }],
  ai: { binding: 'AI' },
  r2_buckets: [{ binding: 'RAW_EMAIL', bucket_name: 'prahari-raw-email' }],
  send_email: [{ name: 'SEND_EMAIL' }],
  workflows: [{ name: 'prahari-email-delivery', binding: 'EMAIL_DELIVERY', class_name: 'EmailDeliveryWorkflow' }],
  queues: {
    producers: [{ binding: 'INGEST_QUEUE', queue: 'prahari-ingest' }],
    consumers: [
      { queue: 'prahari-ingest', max_batch_size: 10, max_batch_timeout: 1, max_retries: 3, dead_letter_queue: 'prahari-ingest-dlq' },
      { queue: 'prahari-ingest-dlq', max_batch_size: 10, max_batch_timeout: 5, max_retries: 3 },
    ],
  },
  vars: {
    AI_GATEWAY_ID: '',
    AI_TRIAGE_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    SUPPORT_EMAIL: 'support@in-nexarq.cftenant.com',
    SUPPORT_FROM: 'support@in-nexarq.cftenant.com',
    SUPPORT_NAME: 'nexarq Support',
    APP_URL: 'https://support.nexarq.dev',
    PENDING_REMINDER_MINS: '4320',
    PENDING_AUTO_CLOSE_MINS: '10080',
    INTAKE_POLICY: 'closed',
    INTAKE_REJECTION_ALERT_THRESHOLD: '5',
    INTAKE_REJECTION_ALERT_WINDOW_MINS: '15',
    INTAKE_REJECTION_ALERT_COOLDOWN_MINS: '60',
    BUSINESS_TIMEZONE: 'Asia/Kolkata',
    BUSINESS_START: '09:00',
    BUSINESS_END: '18:00',
    BUSINESS_DAYS: '1,2,3,4,5',
  },
};

const prahariWeb: WorkerDeployConfig = {
  name: 'prahari-web',
  compatibility_date: '2026-07-01',
  compatibility_flags: ['nodejs_compat'],
  workers_dev: true,
  routes: [{ pattern: 'support.nexarq.dev', custom_domain: true }],
  main: '@tanstack/react-start/server-entry',
  observability: { enabled: true },
  d1_databases: [{ binding: 'DB', database_name: 'prahari-db', database_id: D1_ID }],
  send_email: [{ name: 'SEND_EMAIL' }],
  services: [{ binding: 'API', service: 'prahari-api' }],
  vars: {
    APP_URL: 'https://support.nexarq.dev',
    SUPPORT_EMAIL: 'support@in-nexarq.cftenant.com',
    SUPPORT_FROM: 'support@in-nexarq.cftenant.com',
    SUPPORT_NAME: 'nexarq Support',
  },
};

interface Recorded { path: string; init: CloudflareCallInit }
type Responder = (path: string, init: CloudflareCallInit) => unknown;

function mockCall(responder: Responder): { call: CloudflareCall; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const call = (async (path: string, init: CloudflareCallInit = {}) => {
    calls.push({ path, init });
    return responder(path, init);
  }) as CloudflareCall;
  return { call, calls };
}

const method = (init: CloudflareCallInit) => init.method ?? 'GET';
const summary = (calls: Recorded[]) => calls.map(({ path, init }) => `${method(init)} ${path}`);

function apiVars(): Record<string, unknown>[] {
  return Object.entries(prahariApi.vars as Record<string, string>).map(([name, text]) => ({ name, type: 'plain_text', text }));
}

describe('metadataBindings', () => {
  it('translates the Prahari API config into the bindings wrangler uploads', () => {
    const { bindings, notes } = metadataBindings(prahariApi);
    expect(bindings).toEqual([
      ...apiVars(),
      { name: 'SEND_EMAIL', type: 'send_email' },
      { name: 'TICKET_DO', type: 'durable_object_namespace', class_name: 'TicketDO' },
      { type: 'workflow', name: 'EMAIL_DELIVERY', workflow_name: 'prahari-email-delivery', class_name: 'EmailDeliveryWorkflow' },
      { type: 'queue', name: 'INGEST_QUEUE', queue_name: 'prahari-ingest' },
      { name: 'RAW_EMAIL', type: 'r2_bucket', bucket_name: 'prahari-raw-email' },
      { name: 'DB', type: 'd1', id: D1_ID },
      { name: 'AI', type: 'ai' },
    ]);
    expect(notes).toEqual([]);
  });

  it('translates the Prahari web config into the bindings wrangler uploads', () => {
    const { bindings } = metadataBindings(prahariWeb);
    expect(bindings).toEqual([
      { name: 'APP_URL', type: 'plain_text', text: 'https://support.nexarq.dev' },
      { name: 'SUPPORT_EMAIL', type: 'plain_text', text: 'support@in-nexarq.cftenant.com' },
      { name: 'SUPPORT_FROM', type: 'plain_text', text: 'support@in-nexarq.cftenant.com' },
      { name: 'SUPPORT_NAME', type: 'plain_text', text: 'nexarq Support' },
      { name: 'SEND_EMAIL', type: 'send_email' },
      { name: 'DB', type: 'd1', id: D1_ID },
      { name: 'API', type: 'service', service: 'prahari-api' },
    ]);
  });

  it('covers the remaining binding sections', () => {
    const { bindings } = metadataBindings({
      vars: { LIMITS: { max: 3 } },
      kv_namespaces: [{ binding: 'KV', id: 'kv-id' }],
      send_email: [{ name: 'ONE', destination_address: 'a@b.dev', allowed_sender_addresses: ['x@b.dev'] }, { name: 'MANY', allowed_destination_addresses: ['c@b.dev'] }],
      durable_objects: { bindings: [{ name: 'REMOTE', class_name: 'Room', script_name: 'chat', environment: 'production' }] },
      queues: { producers: [{ binding: 'Q', queue: 'jobs', delivery_delay: 30 }] },
      r2_buckets: [{ binding: 'EU', bucket_name: 'eu-bucket', jurisdiction: 'eu' }],
      vectorize: [{ binding: 'VEC', index_name: 'idx' }],
      hyperdrive: [{ binding: 'HD', id: 'hd-id' }],
      secrets_store_secrets: [{ binding: 'SEC', store_id: 'store', secret_name: 'token' }],
      artifacts: [{ binding: 'ART', namespace: 'ns' }],
      ratelimits: [{ name: 'RL', namespace_id: '1001', simple: { limit: 10, period: 60 } }],
      services: [{ binding: 'SVC', service: 'other', entrypoint: 'Api', props: { tenant: 'a' } }],
      analytics_engine_datasets: [{ binding: 'AE', dataset: 'events' }],
      dispatch_namespaces: [{ binding: 'DISPATCH', namespace: 'tenants', outbound: { service: 'outbound', parameters: ['customer'] } }],
      mtls_certificates: [{ binding: 'CERT', certificate_id: 'cert' }],
      pipelines: [{ binding: 'PIPE', stream: 'stream-id' }],
      worker_loaders: [{ binding: 'LOADER' }],
      logfwdr: { bindings: [{ name: 'LOGS', destination: 'dest' }] },
      browser: { binding: 'BROWSER' },
      ai: { binding: 'AI', staging: true },
      images: { binding: 'IMAGES' },
      version_metadata: { binding: 'VERSION' },
      assets: { binding: 'ASSETS', directory: 'public' },
      vpc_services: [{ binding: 'VPC', service_id: 'svc' }],
      vpc_networks: [{ binding: 'NET', network_id: 'net' }],
      ai_search: [{ binding: 'SEARCH', instance_name: 'docs' }],
      ai_search_namespaces: [{ binding: 'SEARCH_NS', namespace: 'docs' }],
      flagship: [{ binding: 'FLAGS', app_id: 'app' }],
    });
    expect(bindings).toEqual([
      { name: 'LIMITS', type: 'json', json: { max: 3 } },
      { name: 'KV', type: 'kv_namespace', namespace_id: 'kv-id' },
      { name: 'ONE', type: 'send_email', allowed_sender_addresses: ['x@b.dev'], destination_address: 'a@b.dev' },
      { name: 'MANY', type: 'send_email', allowed_destination_addresses: ['c@b.dev'] },
      { name: 'REMOTE', type: 'durable_object_namespace', class_name: 'Room', script_name: 'chat', environment: 'production' },
      { type: 'queue', name: 'Q', queue_name: 'jobs', delivery_delay: 30 },
      { name: 'EU', type: 'r2_bucket', bucket_name: 'eu-bucket', jurisdiction: 'eu' },
      { name: 'VEC', type: 'vectorize', index_name: 'idx' },
      { name: 'SEARCH_NS', type: 'ai_search_namespace', namespace: 'docs' },
      { name: 'SEARCH', type: 'ai_search', instance_name: 'docs' },
      { name: 'HD', type: 'hyperdrive', id: 'hd-id' },
      { name: 'SEC', type: 'secrets_store_secret', store_id: 'store', secret_name: 'token' },
      { name: 'ART', type: 'artifacts', namespace: 'ns' },
      { name: 'FLAGS', type: 'flagship', app_id: 'app' },
      { name: 'RL', type: 'ratelimit', namespace_id: '1001', simple: { limit: 10, period: 60 } },
      { name: 'VPC', type: 'vpc_service', service_id: 'svc' },
      { name: 'NET', type: 'vpc_network', network_id: 'net' },
      { name: 'SVC', type: 'service', service: 'other', entrypoint: 'Api', props: { tenant: 'a' } },
      { name: 'AE', type: 'analytics_engine', dataset: 'events' },
      { name: 'DISPATCH', type: 'dispatch_namespace', namespace: 'tenants', outbound: { worker: { service: 'outbound' }, params: [{ name: 'customer' }] } },
      { name: 'CERT', type: 'mtls_certificate', certificate_id: 'cert' },
      { name: 'PIPE', type: 'pipelines', stream: 'stream-id' },
      { name: 'LOADER', type: 'worker_loader' },
      { name: 'LOGS', type: 'logfwdr', destination: 'dest' },
      { name: 'BROWSER', type: 'browser' },
      { name: 'AI', staging: true, type: 'ai' },
      { name: 'IMAGES', type: 'images' },
      { name: 'VERSION', type: 'version_metadata' },
      { name: 'ASSETS', type: 'assets' },
    ]);
  });

  it('inherits bindings it cannot translate and uses resolved D1 ids', () => {
    const config = {
      kv_namespaces: [{ binding: 'KV' }],
      r2_buckets: [{ binding: 'BUCKET' }],
      d1_databases: [{ binding: 'NEW_DB', database_name: 'fresh' }, { binding: 'ORPHAN' }],
      unsafe: { bindings: [{ name: 'RAW', type: 'custom' }], metadata: { x: 1 } },
    };
    const { bindings, notes } = metadataBindings(config, { d1: { NEW_DB: 'resolved-id' } });
    expect(bindings).toEqual([
      { name: 'KV', type: 'inherit' },
      { name: 'BUCKET', type: 'inherit' },
      { name: 'NEW_DB', type: 'd1', id: 'resolved-id' },
      { name: 'ORPHAN', type: 'inherit' },
      { name: 'RAW', type: 'inherit' },
    ]);
    expect(notes).toHaveLength(5);
    expect(metadataBindings(config).bindings).toContainEqual({ name: 'NEW_DB', type: 'inherit' });
  });

  it('rejects duplicate names and malformed sections', () => {
    expect(() => metadataBindings({ vars: { DB: 'x' }, d1_databases: [{ binding: 'DB', database_id: 'id' }] })).toThrow(expect.objectContaining({ code: 'WORKER_BINDING_DUPLICATE' }));
    expect(() => metadataBindings({ kv_namespaces: 'nope' })).toThrow(WorkerBuildFailure);
    expect(() => metadataBindings({ vars: { 'bad name': 'x' } })).toThrow(expect.objectContaining({ code: 'WORKER_CONFIG_INVALID' }));
    expect(() => metadataBindings({ vars: { BIG: 'x'.repeat(6000) } })).toThrow(WorkerBuildFailure);
    expect(() => metadataBindings({ vectorize: [{ binding: 'V' }] })).toThrow(WorkerBuildFailure);
    expect(() => metadataBindings({ pipelines: [{ binding: 'P' }] })).toThrow(WorkerBuildFailure);
    expect(() => metadataBindings({ r2_buckets: Array.from({ length: 201 }, (_, i) => ({ binding: `B${i}`, bucket_name: `b${i}` })) })).toThrow(WorkerBuildFailure);
  });
});

describe('scriptMetadata', () => {
  it('mirrors wrangler deploy metadata with secrets kept and migrations passed through', () => {
    const migrations = { new_tag: 'v1', steps: [{ new_sqlite_classes: ['TicketDO'] }] };
    const { metadata } = scriptMetadata({ config: prahariApi, mainModule: 'index.js', annotations: { 'workers/message': 'Land #4' }, migrations });
    expect(metadata).toEqual({
      main_module: 'index.js',
      bindings: metadataBindings(prahariApi).bindings,
      compatibility_date: '2026-07-01',
      compatibility_flags: ['nodejs_compat'],
      migrations,
      keep_bindings: ['secret_text', 'secret_key'],
      annotations: { 'workers/message': 'Land #4' },
      observability: { enabled: true },
    });
    expect(SCRIPT_UPLOAD_QUERY).toEqual({ bindings_inherit: 'strict' });
  });

  it('carries assets, placement, consumers, limits, logpush, exports and containers', () => {
    const { metadata, notes } = scriptMetadata({
      config: {
        compatibility_date: '2026-07-01',
        placement: { mode: 'smart' },
        tail_consumers: [{ service: 'tail' }],
        streaming_tail_consumers: [{ service: 'stream' }],
        limits: { cpu_ms: 100 },
        logpush: true,
        exports: { Room: { type: 'durable-object' }, Flow: { type: 'workflow', name: 'flow' }, Other: { type: 'unknown' } },
        containers: [{ class_name: 'Box', name: 'box', image: './Dockerfile' }],
      },
      mainModule: 'worker.js',
      assets: { jwt: 'jwt-token', config: { html_handling: 'auto-trailing-slash' } },
      migrations: { new_tag: 'v1', steps: [] },
    });
    expect(metadata).toEqual({
      main_module: 'worker.js',
      bindings: [],
      containers: [{ name: 'box', class_name: 'Box' }],
      compatibility_date: '2026-07-01',
      exports: { Room: { type: 'durable-object' }, Flow: { type: 'workflow', name: 'flow' } },
      keep_bindings: ['secret_text', 'secret_key'],
      logpush: true,
      placement: { mode: 'smart' },
      tail_consumers: [{ service: 'tail' }],
      streaming_tail_consumers: [{ service: 'stream' }],
      limits: { cpu_ms: 100 },
      assets: { jwt: 'jwt-token', config: { html_handling: 'auto-trailing-slash' } },
    });
    expect(notes.join(' ')).toMatch(/migrations were not sent/);
    expect(notes.join(' ')).toMatch(/Container images/);
  });

  it('requires a compatibility date', () => {
    expect(() => scriptMetadata({ config: { name: 'x' }, mainModule: 'index.js' })).toThrow(expect.objectContaining({ code: 'WORKER_COMPATIBILITY_DATE_REQUIRED' }));
  });
});

describe('ensureResources', () => {
  it('creates missing resources and reuses existing ones', async () => {
    const { call, calls } = mockCall((path, init) => {
      if (path.endsWith('/r2/buckets/prahari-raw-email')) return null;
      if (path.endsWith('/queues') && method(init) === 'GET') return { success: true, result: [{ queue_name: 'prahari-ingest', queue_id: 'q1' }], result_info: { page: 1, per_page: 100, total_count: 1 } };
      if (path.endsWith('/d1/database') && method(init) === 'GET') return [];
      if (path.endsWith('/d1/database') && method(init) === 'POST') return { uuid: 'new-db-id', name: 'fresh-db' };
      return {};
    });
    const config = { ...prahariApi, d1_databases: [{ binding: 'DB', database_name: 'fresh-db' }, { binding: 'KEEP', database_id: D1_ID }] };
    const result = await ensureResources(call, ACCOUNT, config);
    expect(calls).toEqual([
      { path: `/accounts/${ACCOUNT}/r2/buckets/prahari-raw-email`, init: { allowNotFound: true } },
      { path: `/accounts/${ACCOUNT}/r2/buckets`, init: { method: 'POST', json: { name: 'prahari-raw-email' } } },
      { path: `/accounts/${ACCOUNT}/queues`, init: { query: { name: ['prahari-ingest', 'prahari-ingest-dlq'], page: '1' }, envelope: true } },
      { path: `/accounts/${ACCOUNT}/queues`, init: { method: 'POST', json: { queue_name: 'prahari-ingest-dlq' } } },
      { path: `/accounts/${ACCOUNT}/d1/database`, init: { query: { name: 'fresh-db' } } },
      { path: `/accounts/${ACCOUNT}/d1/database`, init: { method: 'POST', json: { name: 'fresh-db' } } },
    ]);
    expect(result.created).toEqual(['R2 bucket prahari-raw-email', 'Queue prahari-ingest-dlq', 'D1 database fresh-db']);
    expect(result.resolved).toEqual({ d1: { DB: 'new-db-id' } });
    expect(metadataBindings(config, result.resolved).bindings).toContainEqual({ name: 'DB', type: 'd1', id: 'new-db-id' });
  });

  it('is a no-op when everything exists, follows queue pages and sends the R2 jurisdiction', async () => {
    const { call, calls } = mockCall((path, init) => {
      if (path.includes('/r2/buckets/')) return { name: 'eu-bucket' };
      if (path.endsWith('/queues')) {
        const page = (init.query as Record<string, string>).page;
        return page === '1'
          ? { success: true, result: [{ queue_name: 'a' }], result_info: { page: 1, per_page: 1, total_count: 2 } }
          : { success: true, result: [{ queue_name: 'b' }], result_info: { page: 2, per_page: 1, total_count: 2 } };
      }
      if (path.endsWith('/d1/database')) return [{ name: 'db', uuid: 'existing-id' }];
      throw new Error(`unexpected ${path}`);
    });
    const result = await ensureResources(call, ACCOUNT, {
      r2_buckets: [{ binding: 'EU', bucket_name: 'eu-bucket', jurisdiction: 'eu' }],
      queues: { producers: [{ binding: 'A', queue: 'a' }], consumers: [{ queue: 'b' }] },
      d1_databases: [{ binding: 'DB', database_name: 'db' }],
    });
    expect(summary(calls)).toEqual([`GET /accounts/${ACCOUNT}/r2/buckets/eu-bucket`, `GET /accounts/${ACCOUNT}/queues`, `GET /accounts/${ACCOUNT}/queues`, `GET /accounts/${ACCOUNT}/d1/database`]);
    expect(calls[0].init.headers).toEqual({ 'cf-r2-jurisdiction': 'eu' });
    expect(result.created).toEqual([]);
    expect(result.resolved.d1).toEqual({ DB: 'existing-id' });
  });

  it('validates every name before calling Cloudflare', async () => {
    const { call, calls } = mockCall(() => null);
    await expect(ensureResources(call, ACCOUNT, { r2_buckets: [{ binding: 'B', bucket_name: 'ok' }], queues: { producers: [{ binding: 'Q', queue: '../x' }] } })).rejects.toThrow(WorkerBuildFailure);
    expect(calls).toEqual([]);
  });
});

describe('applyTriggers', () => {
  const queues: Record<string, unknown> = {
    'prahari-ingest': { queue_id: 'qid1', queue_name: 'prahari-ingest', consumers: [{ consumer_id: 'c1', type: 'worker', script: 'prahari-api' }] },
    'prahari-ingest-dlq': { queue_id: 'qid2', queue_name: 'prahari-ingest-dlq', consumers: [{ consumer_id: 'c9', type: 'worker', script: 'someone-else' }] },
  };
  const apiResponder: Responder = (path, init) => {
    if (path.endsWith('/queues')) return { success: true, result: [queues[(init.query as Record<string, string>).name]] };
    return {};
  };

  it('applies Prahari API triggers like wrangler deploy', async () => {
    const { call, calls } = mockCall(apiResponder);
    const { notes } = await applyTriggers(call, ACCOUNT, 'prahari-api', prahariApi);
    const script = `/accounts/${ACCOUNT}/workers/scripts/prahari-api`;
    expect(calls).toEqual([
      { path: `${script}/subdomain`, init: { method: 'POST', json: { enabled: false }, headers: { 'Cloudflare-Workers-Script-Api-Date': '2025-08-01' } } },
      { path: `/accounts/${ACCOUNT}/queues`, init: { query: { name: 'prahari-ingest', page: '1' }, envelope: true } },
      { path: `/accounts/${ACCOUNT}/queues/qid1/consumers/c1`, init: { method: 'PUT', json: { type: 'worker', dead_letter_queue: 'prahari-ingest-dlq', script_name: 'prahari-api', settings: { batch_size: 10, max_retries: 3, max_wait_time_ms: 1000 } } } },
      { path: `/accounts/${ACCOUNT}/queues`, init: { query: { name: 'prahari-ingest-dlq', page: '1' }, envelope: true } },
      { path: `/accounts/${ACCOUNT}/queues/qid2/consumers`, init: { method: 'POST', json: { type: 'worker', script_name: 'prahari-api', settings: { batch_size: 10, max_retries: 3, max_wait_time_ms: 5000 } } } },
      { path: `/accounts/${ACCOUNT}/workflows/prahari-email-delivery`, init: { method: 'PUT', json: { script_name: 'prahari-api', class_name: 'EmailDeliveryWorkflow' } } },
      { path: `${script}/script-settings`, init: { method: 'PATCH', json: { observability: { enabled: true } } } },
    ]);
    expect(notes).toEqual([]);
  });

  it('sets crons only when configured and defaults observability off', async () => {
    const { call, calls } = mockCall(() => ({}));
    await applyTriggers(call, ACCOUNT, 'cron-worker', { triggers: { crons: ['*/5 * * * *'] }, preview_urls: true, logpush: true });
    expect(calls.map(({ path, init }) => [method(init), path.replace(`/accounts/${ACCOUNT}/workers/scripts/cron-worker`, ''), init.json])).toEqual([
      ['POST', '/subdomain', { enabled: true, previews_enabled: true }],
      ['PUT', '/schedules', [{ cron: '*/5 * * * *' }]],
      ['PATCH', '/script-settings', { observability: { enabled: false }, logpush: true }],
    ]);
    const empty = mockCall(() => ({}));
    await applyTriggers(empty.call, ACCOUNT, 'cron-worker', { triggers: {} });
    expect(summary(empty.calls).some((line) => line.endsWith('/schedules'))).toBe(false);
  });

  it('leaves an already attached custom domain alone', async () => {
    const { call, calls } = mockCall((path) => path.endsWith('/workers/domains') ? [{ hostname: 'support.nexarq.dev', service: 'prahari-web', zone_id: ZONE }] : {});
    const { notes } = await applyTriggers(call, ACCOUNT, 'prahari-web', prahariWeb);
    expect(calls[0].init.json).toEqual({ enabled: true });
    expect(calls[1]).toEqual({ path: `/accounts/${ACCOUNT}/workers/domains`, init: { query: { hostname: 'support.nexarq.dev' } } });
    expect(summary(calls)).toEqual([
      `POST /accounts/${ACCOUNT}/workers/scripts/prahari-web/subdomain`,
      `GET /accounts/${ACCOUNT}/workers/domains`,
      `PATCH /accounts/${ACCOUNT}/workers/scripts/prahari-web/script-settings`,
    ]);
    expect(notes).toEqual(['Custom domain support.nexarq.dev is already attached to prahari-web.']);
  });

  it('attaches a new custom domain after resolving its zone', async () => {
    const { call, calls } = mockCall((path, init) => {
      if (path.endsWith('/workers/domains') && method(init) === 'GET') return [];
      if (path === '/zones') return (init.query as Record<string, string>).name === 'nexarq.dev' ? [{ id: ZONE, name: 'nexarq.dev' }] : [];
      return {};
    });
    await applyTriggers(call, ACCOUNT, 'prahari-web', prahariWeb);
    expect(calls.slice(1, 5)).toEqual([
      { path: `/accounts/${ACCOUNT}/workers/domains`, init: { query: { hostname: 'support.nexarq.dev' } } },
      { path: '/zones', init: { query: { name: 'support.nexarq.dev', 'account.id': ACCOUNT } } },
      { path: '/zones', init: { query: { name: 'nexarq.dev', 'account.id': ACCOUNT } } },
      { path: `/accounts/${ACCOUNT}/workers/domains`, init: { method: 'PUT', json: { hostname: 'support.nexarq.dev', service: 'prahari-web', environment: 'production', zone_id: ZONE } } },
    ]);
  });

  it('names the fix when a new custom domain needs a zone the connection cannot read', async () => {
    const { call, calls } = mockCall((path, init) => {
      if (path.endsWith('/workers/domains') && method(init) === 'GET') return [];
      if (path === '/zones') throw new Error('Authentication error (403)');
      return {};
    });
    await expect(applyTriggers(call, ACCOUNT, 'prahari-web', prahariWeb)).rejects.toMatchObject({ code: 'CUSTOM_DOMAIN_ZONE_LOOKUP_FAILED', message: expect.stringContaining('Add "zone_id" to that route') });
    expect(calls.some(({ init }) => method(init) === 'PUT')).toBe(false);
  });

  it('fails without reassigning a domain attached to another Worker', async () => {
    const { call, calls } = mockCall((path) => path.endsWith('/workers/domains') ? [{ hostname: 'support.nexarq.dev', service: 'legacy-web' }] : {});
    await expect(applyTriggers(call, ACCOUNT, 'prahari-web', prahariWeb)).rejects.toMatchObject({ code: 'CUSTOM_DOMAIN_CONFLICT' });
    expect(calls.some(({ init }) => method(init) === 'PUT')).toBe(false);
  });

  it('leaves zone routes untouched and names the failing trigger', async () => {
    const { call, calls } = mockCall(() => ({}));
    const { notes } = await applyTriggers(call, ACCOUNT, 'routed', { routes: ['example.com/*', { pattern: 'api.example.com/*', zone_name: 'example.com' }] });
    expect(calls[0].init.json).toEqual({ enabled: false });
    expect(summary(calls).every((line) => !line.includes('/zones') && !line.includes('/routes'))).toBe(true);
    expect(notes).toEqual(['Zone routes were left unchanged: example.com/*, api.example.com/*.']);

    const failing = mockCall((path) => { if (path.endsWith('/schedules')) throw new Error('Cloudflare rejected PUT'); return {}; });
    await expect(applyTriggers(failing.call, ACCOUNT, 'routed', { triggers: { crons: ['0 * * * *'] } })).rejects.toMatchObject({ code: 'WORKER_TRIGGER_FAILED', message: expect.stringContaining('cron schedules') });
    expect(summary(failing.calls).some((line) => line.endsWith('/script-settings'))).toBe(false);
  });

  it('rejects workflow settings on external scripts before any call', async () => {
    const { call, calls } = mockCall(() => ({}));
    await expect(applyTriggers(call, ACCOUNT, 'me', { workflows: [{ name: 'flow', binding: 'FLOW', class_name: 'Flow', script_name: 'other', limits: { steps: 5 } }] })).rejects.toThrow(WorkerBuildFailure);
    expect(calls).toEqual([]);
  });
});

describe('currentMigrationTag', () => {
  it('reads the deployed migration tag', async () => {
    const found = mockCall(() => ({ default_environment: { script: { migration_tag: 'v1' } } }));
    expect(await currentMigrationTag(found.call, ACCOUNT, 'prahari-api')).toEqual({ exists: true, tag: 'v1' });
    expect(found.calls).toEqual([{ path: `/accounts/${ACCOUNT}/workers/services/prahari-api`, init: { allowNotFound: true } }]);
    expect(await currentMigrationTag(mockCall(() => null).call, ACCOUNT, 'new-worker')).toEqual({ exists: false });
    expect(await currentMigrationTag(mockCall(() => ({ default_environment: { script: {} } })).call, ACCOUNT, 'plain')).toEqual({ exists: true });
  });
});

describe('requiredDeployScopes', () => {
  it('derives OAuth scopes from the config', () => {
    expect(requiredDeployScopes(prahariApi, { d1Migrations: false, uploadOnly: false })).toEqual(['workers-scripts.edit', 'workers-r2.write', 'ai.write', 'queues.write']);
    expect(requiredDeployScopes(prahariApi, { d1Migrations: true, uploadOnly: false })).toEqual(['workers-scripts.edit', 'd1.write', 'workers-r2.write', 'ai.write', 'queues.write']);
    expect(requiredDeployScopes(prahariWeb, { d1Migrations: false, uploadOnly: false })).toEqual(['workers-scripts.edit', 'workers-routes.write']);
    expect(requiredDeployScopes(prahariWeb, { d1Migrations: false, uploadOnly: true })).toEqual(['workers-scripts.edit']);
    expect(requiredDeployScopes({ d1_databases: [{ binding: 'DB', database_name: 'x' }] }, { d1Migrations: false, uploadOnly: true })).toEqual(['workers-scripts.edit', 'd1.write']);
  });
});

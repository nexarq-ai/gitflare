import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { securityHarness } from './security-harness';
import { DEMO_FEATURES, demoDisabledRoute } from '../src/worker/demo';
import { demoDisabledApi } from '../src/worker/demo-runtime';
import { demoExamples } from '../src/worker/demo-examples';
import { DEMO_VISITOR_ID, demoSeedPlan } from '../src/worker/demo-seed';
import type { AppEnv } from '../src/worker/env';
import type { DemoFeatureId } from '../src/shared/demo-features';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const day = new Date('2026-10-18T05:00:00Z');
const plan = demoSeedPlan(1, day);
const edge = plan.repositories[0].repository;
const r = `/api/repositories/${edge.id}`;

const REPLACED: [string, DemoFeatureId][] = [
  ['/api/cloudflare', 'cloudflare'], ['/api/cloudflare/accounts', 'cloudflare'], ['/api/cloudflare/resources', 'cloudflare'],
  ['/api/cloudflare/installation-credential', 'installation-credential'],
  [`${r}/cloudflare/connection`, 'cloudflare'], [`${r}/cloudflare/connection/accounts`, 'cloudflare'], [`${r}/cloudflare/connection/resources`, 'cloudflare'],
  [`${r}/cloudflare`, 'cloudflare-resources'], [`${r}/cloudflare/usage`, 'cloudflare-resources'],
  [`${r}/deployments`, 'deployments'], [`${r}/deployments/detect`, 'deployments'],
  [`${r}/secrets`, 'secrets'], [`${r}/secrets/catalog`, 'secrets'],
  [`${r}/github-mirror`, 'github-mirror'], [`${r}/preview-settings`, 'previews'],
];
const MERGED: [string, DemoFeatureId, string][] = [
  ['/api/models', 'ai-models', 'gateway'], ['/api/ai-keys', 'ai-keys', 'keys'], ['/api/settings/ai', 'ai-features', 'enabled'],
  ['/api/access', 'people', 'members'], ['/api/mcp', 'mcp-clients', 'endpoint'], ['/api/workspaces', 'workspace-creation', 'workspaces'], [`${r}/check-settings`, 'checks', 'autoIncrease'],
];

async function demoEnv(overrides: Record<string, unknown> = {}) {
  const harness = securityHarness({ EDITION: 'self-hosted', DEMO_MODE: 'true' });
  await harness.service.demoInstall({ workspaceId: plan.workspaceId, workspaceName: plan.workspaceName, users: plan.users, visitorId: DEMO_VISITOR_ID });
  const fail = () => { throw new Error('A demo-disabled read reached its real handler.'); };
  const coordinator = {
    listRepositories: async () => [edge], getRepository: async (id: string) => id === edge.id ? edge : undefined, getAiEnabled: async () => true, listSummaryCache: async () => [], saveSummaryCache: async () => {},
    listMissionSummaries: async () => [], getModelConnections: async () => [], getDefaultModel: async () => null, getAiCredentials: async () => ({ keys: [], gateway: null }), getCheckSettings: async () => null, getCheckDurations: async () => [],
    demoControl: async () => ({ current: { generation: 1, workspaceId: plan.workspaceId, seededAt: day.toISOString(), anchor: plan.anchor }, nextGeneration: 2, stale: [], resetting: null }),
    deployState: fail, getSecretLinks: fail, getGitHubMirror: fail, getPreviewSettings: fail,
  };
  return { GITFLARE_SECURITY: harness.namespace, GITFLARE_COORDINATOR: { getByName: () => coordinator }, APP_ENV: 'production', EDITION: 'self-hosted', DEMO_MODE: 'true', ASSETS: { fetch: async () => new Response('app') }, ...overrides } as unknown as AppEnv;
}

async function send(env: AppEnv, path: string) {
  const worker = (await import('../src/worker/index')).default;
  return worker.fetch(new Request(`https://demo.gitflare.test${path}`, { headers: { Origin: 'https://demo.gitflare.test' } }), env);
}

const clients: { close(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function mcp(env: AppEnv) {
  const worker = (await import('../src/worker/index')).default;
  const client = new Client({ name: 'demo-disabled-test', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL('https://demo.gitflare.test/mcp'), { fetch: (input, init) => { const request = new Request(input, init); request.headers.set('Host', 'demo.gitflare.test'); return worker.fetch(request, env); } }));
  return client;
}

describe('demo-disabled routes', () => {
  it('matches every disabled snapshot GET and nothing else', () => {
    for (const [path, feature] of [...REPLACED, ...MERGED.map(([path, feature]) => [path, feature] as const)]) expect(demoDisabledRoute('GET', path)?.feature, path).toBe(feature);
    expect(demoDisabledRoute('GET', '/api/workspace')).toMatchObject({ feature: 'ai-features', mode: 'merge', field: 'ai' });
    for (const path of ['/api/cloudflare/callback', `${r}/issues`, `${r}/tree`, '/api/missions/m1', `${r}/branch-protection`]) expect(demoDisabledRoute('GET', path), path).toBeNull();
    expect(demoDisabledRoute('POST', `${r}/secrets`)).toBeNull();
    for (const feature of Object.values(DEMO_FEATURES)) expect(['/docs/overview', '/docs/install', '/docs/admin', '/docs/cloudflare-permissions', '/docs/repositories', '/docs/github-mirror', '/docs/mcp', '/docs/agents']).toContain(feature.docs);
  });

  it('replaces setup snapshots with the demo-disabled shape and examples', async () => {
    const env = await demoEnv();
    for (const [path, feature] of REPLACED) {
      const response = await send(env, path);
      expect(response.status, path).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body, path).toMatchObject({ canManage: false, demo: { disabled: true, feature, name: DEMO_FEATURES[feature].name, reason: DEMO_FEATURES[feature].reason, install: 'https://gitflare.io/docs/install' } });
      expect(JSON.stringify(body), path).not.toMatch(/OAuth client|Connect Cloudflare|Configure this installation/);
    }
    const secrets = await (await send(env, `${r}/secrets`)).json() as { examples: { secretReferences: { binding: string; environment: string }[] } };
    expect(secrets.examples.secretReferences.map((item) => [item.binding, item.environment])).toEqual([['PAYMENTS_API_KEY', 'production'], ['WEBHOOK_SIGNING_KEY', 'staging']]);
    expect(JSON.stringify(secrets.examples)).not.toMatch(/value|token|password/i);
    const deploys = await (await send(env, `${r}/deployments`)).json() as { examples: { environments: { environment: string; worker: string; commit: string }[] } };
    expect(deploys.examples.environments.map((item) => [item.environment, item.worker])).toEqual([['production', 'edge-store'], ['staging', 'edge-store-staging']]);
    expect(Object.values(plan.repositories[0].history.shas)).toContain(deploys.examples.environments[0].commit);
    expect((await send(env, '/api/repositories/missing/secrets')).status).toBe(404);
  });

  it('marks readable settings as demo-disabled without dropping their data', async () => {
    const env = await demoEnv();
    for (const [path, feature, kept] of MERGED) {
      const response = await send(env, path);
      expect(response.status, path).toBe(200);
      const body = await response.json() as Record<string, unknown>;
      expect(body, path).toMatchObject({ canManage: false, demo: { disabled: true, feature } });
      expect(body, path).toHaveProperty(kept);
    }
    const workspace = await (await send(env, '/api/workspace')).json() as { ai: Record<string, unknown>; repositories: unknown[] };
    expect(workspace.repositories).toHaveLength(1);
    expect(workspace.ai).toMatchObject({ enabled: true, canManage: false, demo: { feature: 'ai-features' } });
    const models = await (await send(env, '/api/models')).json() as { examples: { models: { model: string }[] } };
    expect(models.examples.models.map((item) => item.model)).toContain('openai/gpt-6-luna');
  });

  it('reports the same shape through the MCP read tools', async () => {
    const env = await demoEnv();
    const client = await mcp(env);
    const tools: [string, Record<string, unknown>, DemoFeatureId][] = [
      ['gitflare_cloudflare_connection', {}, 'cloudflare'], ['gitflare_cloudflare_connection', { action: 'installation-credential' }, 'installation-credential'],
      ['gitflare_cloudflare_connection', { action: 'resources', repository_id: edge.id }, 'cloudflare'], ['gitflare_cloudflare_project', { repositoryId: edge.id, action: 'usage' }, 'cloudflare-resources'],
      ['gitflare_deployments', { repository_id: edge.id, deployment_id: 'x' }, 'deployments'], ['gitflare_detect_deploy_setup', { repository_id: edge.id }, 'deployments'], ['gitflare_deploy_access', { repository_id: edge.id }, 'deployments'],
      ['gitflare_secrets', { repository_id: edge.id }, 'secrets'], ['gitflare_github_mirror', { repository_id: edge.id }, 'github-mirror'], ['gitflare_preview_settings', { repository_id: edge.id }, 'previews'],
      ['gitflare_check_settings', { repository_id: edge.id }, 'checks'], ['gitflare_model_connections', {}, 'ai-models'], ['gitflare_ai_keys', {}, 'ai-keys'], ['gitflare_ai_settings', {}, 'ai-features'], ['gitflare_access_status', {}, 'people'], ['gitflare_list_workspaces', {}, 'workspace-creation'],
    ];
    for (const [name, args, feature] of tools) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, name).toBeFalsy();
      expect(result.structuredContent, name).toMatchObject({ canManage: false, demo: { disabled: true, feature } });
    }
    const status = await client.callTool({ name: 'gitflare_workspace_status', arguments: {} });
    expect(status.structuredContent).toMatchObject({ mcp: { demo: { feature: 'mcp-clients' } } });
  });

  it('passes every route through unchanged outside demo mode', async () => {
    const env = { DEMO_MODE: undefined } as unknown as AppEnv;
    for (const [path] of [...REPLACED, ...MERGED]) {
      const normal = Response.json({ canManage: true, connected: false });
      const result = await demoDisabledApi(new Request(`https://gitflare.test${path}`), env, { next: async () => normal, principal: () => { throw new Error('unused'); }, repository: () => { throw new Error('unused'); } });
      expect(result, path).toBe(normal);
      expect(await result.json()).toEqual({ canManage: true, connected: false });
    }
  });

  it('derives examples deterministically from the seed plan', () => {
    const again = demoSeedPlan(1, new Date('2026-10-18T22:00:00Z'));
    for (const feature of Object.keys(DEMO_FEATURES) as DemoFeatureId[]) expect(demoExamples(feature, again, edge)).toEqual(demoExamples(feature, plan, edge));
    const next = demoExamples('secrets', demoSeedPlan(1, new Date('2026-10-19T05:00:00Z')), edge);
    expect(next).not.toEqual(demoExamples('secrets', plan, edge));
  });

  it('renders the shared panel with the docs link, install link and labelled examples', async () => {
    const { default: DemoFeaturePanel } = await import('../src/ui/DemoFeaturePanel');
    const { demoDisabled } = await import('../src/shared/demo-features');
    const html = renderToStaticMarkup(createElement(DemoFeaturePanel, { demo: demoDisabled('secrets'), examples: demoExamples('secrets', plan, edge) }));
    expect(html).toContain('Repository secrets');
    expect(html).toContain('Disabled in the demo');
    expect(html).toContain('href="/docs/cloudflare-permissions"');
    expect(html).toContain('href="https://gitflare.io/docs/install"');
    expect(html).toContain('Secret references');
    expect(html).toContain('>Example<');
    expect(html).toContain('PAYMENTS_API_KEY');
    expect(renderToStaticMarkup(createElement(DemoFeaturePanel, { feature: 'repository-creation', headingLevel: 3 }))).toMatch(/<h3[^>]*>Repository creation<\/h3>/);
    const css = readFileSync(resolve(import.meta.dirname, '../src/ui/demo-feature-panel.css'), 'utf8');
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
    expect(css).toMatch(/@media \(max-width: 640px\)/);
  });

  it('wires the panel into every page that shows a disabled feature', () => {
    for (const file of ['SecretSettings', 'GitHubMirror', 'PreviewSettings', 'CheckSettings', 'CloudflareConnection', 'Deployments', 'InstallationCredential', 'ModelConnections', 'AiSettingsPanel', 'PeopleSettings', 'McpConnections', 'App']) {
      expect(readFileSync(resolve(import.meta.dirname, `../src/ui/${file}.tsx`), 'utf8'), file).toMatch(/<DemoFeaturePanel /);
    }
  });
});

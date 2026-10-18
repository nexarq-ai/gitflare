import type { DemoExamples, DemoExampleRecord, DemoFeatureId } from '../shared/demo-features';
import type { DeploySettings, DeploymentRecord } from './deployments';
import type { DemoRepositoryPlan, DemoSeedPlan } from './demo-seed';
import { defaultModelConnections, WORKERS_AI_CATALOG } from './model-config';

const DAY_MS = 86_400_000;
const EXAMPLE_ACCOUNT_NAME = 'Example Cloudflare account';

function at(plan: DemoSeedPlan, daysAgo: number, hour = 10): string {
  return new Date(Date.parse(plan.anchor) - daysAgo * DAY_MS + hour * 3_600_000).toISOString();
}

function label(item: DemoRepositoryPlan): string { return item.repository.displayName ?? item.repository.name; }

function record<T>(item: DemoRepositoryPlan, key: string): T | undefined {
  return item.records.find(([name]) => name === key)?.[1] as T | undefined;
}

function deployments(item: DemoRepositoryPlan): DeploymentRecord[] {
  return item.records.filter(([key]) => key.startsWith('deployment:')).map(([, value]) => value as DeploymentRecord);
}

function workerNames(item: DemoRepositoryPlan): Record<string, string> {
  const settings = record<DeploySettings>(item, 'deploy-settings');
  const environments = Object.entries(settings?.environments ?? {}).filter(([, value]) => value?.workerName);
  if (environments.length) return Object.fromEntries(environments.map(([name, value]) => [name, value!.workerName]));
  return { production: label(item), staging: `${label(item)}-staging` };
}

function accountId(plan: DemoSeedPlan): string {
  for (const item of plan.repositories) {
    const id = Object.values(record<DeploySettings>(item, 'deploy-settings')?.environments ?? {}).find((value) => value?.accountId)?.accountId;
    if (id) return id;
  }
  return '0'.repeat(32);
}

function environmentRows(item: DemoRepositoryPlan): DemoExampleRecord[] {
  const workers = workerNames(item);
  const history = deployments(item).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return Object.entries(workers).map(([environment, workerName]) => {
    const last = history.find((deployment) => deployment.environment === environment);
    const live = history.find((deployment) => deployment.environment === environment && deployment.status === 'succeeded');
    return { environment, worker: workerName, lastDeploy: last?.status.replace(/_/g, ' ') ?? 'none', commit: last?.commitSha ?? null, trigger: last?.trigger ?? null, deployedAt: last?.createdAt ?? null, liveCommit: live?.commitSha ?? null };
  });
}

function resourceRows(item: DemoRepositoryPlan): DemoExampleRecord[] {
  return Object.entries(workerNames(item)).map(([environment, name]) => ({ type: 'Worker', name, environment }));
}

function secretRows(plan: DemoSeedPlan, item: DemoRepositoryPlan): DemoExampleRecord[] {
  const workers = workerNames(item);
  const prefix = label(item).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  return [
    { binding: 'PAYMENTS_API_KEY', secret: `${prefix}_payments_key`, environment: 'production', workers: [workers.production ?? label(item)], status: 'Verified', rotated: at(plan, 9) },
    { binding: 'WEBHOOK_SIGNING_KEY', secret: `${prefix}_webhook_signing_staging`, environment: 'staging', workers: [workers.staging ?? `${label(item)}-staging`], status: 'Verified', rotated: at(plan, 3, 14) },
  ];
}

function mirrorRows(plan: DemoSeedPlan, item: DemoRepositoryPlan): DemoExampleRecord[] {
  const main = item.history.refs['refs/heads/main'] ?? item.repository.headSha;
  return [{ github: `example-org/${label(item)}`, ref: 'main', state: 'Synced', gitflare: main, githubCommit: main, lastSynced: at(plan, 0, 2) }];
}

function find(plan: DemoSeedPlan, repository?: { id: string; name?: string; displayName?: string }): DemoRepositoryPlan | undefined {
  if (!repository) return undefined;
  const name = repository.displayName ?? repository.name;
  return plan.repositories.find((item) => item.repository.id === repository.id) ?? plan.repositories.find((item) => label(item) === name);
}

export function demoExamples(feature: DemoFeatureId, plan: DemoSeedPlan, repository?: { id: string; name?: string; displayName?: string }): DemoExamples | undefined {
  const target = find(plan, repository) ?? plan.repositories[0];
  if (!target) return undefined;
  switch (feature) {
    case 'secrets': return { secretReferences: secretRows(plan, target) };
    case 'github-mirror': return { mirror: mirrorRows(plan, target) };
    case 'deployments': return { environments: environmentRows(target) };
    case 'cloudflare-resources': return { resources: resourceRows(target) };
    case 'cloudflare': return {
      connection: [{ account: EXAMPLE_ACCOUNT_NAME, accountId: accountId(plan), source: repository ? 'repository' : 'workspace', permissions: ['Workers Scripts', 'D1', 'Secrets Store', 'Account Analytics'], connected: at(plan, 20, 12) }],
      resources: plan.repositories.flatMap((item) => resourceRows(item).map((row): DemoExampleRecord => ({ ...row, repository: label(item) }))).filter((row, index, rows) => rows.findIndex((other) => other.name === row.name) === index),
    };
    case 'previews': return { previewSettings: [{ worker: workerNames(target).staging ?? label(target), lifetime: '1 hour', access: 'Cloudflare Access', allowedDomains: ['example.com'], previewEmail: 'Blocked' }] };
    case 'checks': return { checkSettings: [{ setting: 'Check time limit', value: '5 minutes', source: 'gitflare.json' }, { setting: 'Runner', value: 'standard-1', source: 'default' }, { setting: 'Automatic increase', value: 'Up to 15 minutes on standard-3', source: 'repository setting' }] };
    case 'ai-models': return { models: [...defaultModelConnections(), ...WORKERS_AI_CATALOG].map((model) => ({ model: model.id, label: model.label, source: model.source === 'workers-ai' ? 'Workers AI' : 'AI Gateway' })) };
    case 'ai-keys': return { keys: [{ provider: 'OpenAI', added: at(plan, 20, 12), addedBy: plan.users[0]?.name ?? 'Owner', checkedWith: defaultModelConnections()[0].id }], gateway: [{ gateway: 'gitflare', account: EXAMPLE_ACCOUNT_NAME, authenticated: true }] };
    case 'ai-features': return undefined;
    case 'people': return { invitations: [{ email: 'new-teammate@example.com', role: 'Contributor', status: 'Pending', expires: at(plan, -6) }] };
    case 'installation-credential': return { credential: [{ source: 'Workspace Cloudflare connection', account: EXAMPLE_ACCOUNT_NAME, worker: 'gitflare-previews', permissions: ['Workers Scripts', 'D1'], checked: at(plan, 1, 9) }] };
    case 'mcp-clients': return { clients: [{ client: 'Claude Code', access: 'Owner (admin)', authorized: at(plan, 6, 11), lastUsed: at(plan, 0, 1) }, { client: 'Cursor', access: 'Read only', authorized: at(plan, 2, 16), lastUsed: at(plan, 1, 9) }] };
    case 'repository-creation': return undefined;
  }
}

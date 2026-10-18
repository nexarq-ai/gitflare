import { createHash } from 'node:crypto';
import type { AgentRun, Check, FileChange, Issue, IssueComment, Mission, MissionEvent, ProposalReview, Release, Repository } from '../shared/types';
import { buildDemoHistory, type BuiltDemoHistory, type DemoCommit, type DemoPerson } from './demo-git';
import { defaultBranchRule } from './branch-protection';
import type { DeployEnvironmentSettings, DeploymentRecord, DeploySettings } from './deployments';
import type { LastPreview } from './coordinator';
import type { Principal, Role } from './security';
import { neonDriftRuns, type DemoRunsPlan } from './demo-runs';
import { DEFAULT_MODEL } from '../shared/models';

export const DEMO_VISITOR_ID = 'demo-visitor';
export const DEMO_WORKSPACE_NAME = 'Gitflare demo';
export const DEMO_MODEL = DEFAULT_MODEL;
const DEMO_ACCOUNT_ID = 'de000000000000000000000000000000';

export interface DemoUser { id: string; name: string; email: string; role: Role }
export type DemoRecord = [string, unknown];
export interface DemoRepositoryPlan { repository: Repository; history: BuiltDemoHistory; records: DemoRecord[] }
export interface DemoSeedPlan { generation: number; anchor: string; workspaceId: string; workspaceName: string; users: DemoUser[]; repositories: DemoRepositoryPlan[]; catalogRecords: DemoRecord[] }

export const DEMO_USERS: DemoUser[] = [
  { id: DEMO_VISITOR_ID, name: 'Demo visitor', email: 'visitor@demo.gitflare.io', role: 'Owner' },
  { id: 'demo-maya', name: 'Maya Chen', email: 'maya@example.com', role: 'Maintainer' },
  { id: 'demo-omar', name: 'Omar Haddad', email: 'omar@example.com', role: 'Reviewer' },
  { id: 'demo-lena', name: 'Lena Fischer', email: 'lena@example.com', role: 'Deployer' },
  { id: 'demo-sam', name: 'Sam Okafor', email: 'sam@example.com', role: 'Contributor' },
];
const people: Record<string, DemoPerson> = Object.fromEntries(DEMO_USERS.map((user) => [user.id, { name: user.name, email: user.email }]));
const agentPerson: DemoPerson = { name: 'Gitflare agent', email: 'agent@demo.gitflare.io' };

function digest(...parts: (string | number)[]): string { return createHash('sha256').update(parts.join('\u0000')).digest('hex'); }

export function demoUuid(...parts: (string | number)[]): string {
  const hex = digest('gitflare-demo', ...parts);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function demoWorkspaceId(generation: number): string { return demoUuid('workspace', generation); }

export function demoStorageName(workspaceId: string, name: string): string {
  if (name.length > 29) throw new Error(`Demo repository name ${name} is too long`);
  return `w-${workspaceId.replace(/-/g, '')}-${name}`;
}

export function demoAnchor(now: Date): number { return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()); }

interface Clock { iso(daysAgo: number, hour?: number, minute?: number): string; unix(daysAgo: number, hour?: number, minute?: number): number }
function clock(anchor: number): Clock {
  const at = (daysAgo: number, hour = 10, minute = 0) => anchor - daysAgo * 86_400_000 + hour * 3_600_000 + minute * 60_000;
  return { iso: (d, h, m) => new Date(at(d, h, m)).toISOString(), unix: (d, h, m) => Math.floor(at(d, h, m) / 1000) };
}

function commit(id: string, parent: string | undefined, message: string, author: DemoPerson, at: number, changes: Record<string, string | null>): DemoCommit {
  return { id, ...(parent ? { parent } : {}), message, author, at, changes };
}

function patch(path: string, removed: string[], added: string[]): FileChange {
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${removed.length} +1,${added.length} @@`, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)];
  return { path, additions: added.length, deletions: removed.length, patch: `${lines.join('\n')}\n`, runIds: [] };
}

interface MissionSpec {
  key: string; title: string; prompt: string; status: Mission['status']; baseSha: string | null; candidateSha: string | null; created: string; updated: string;
  runs: Omit<AgentRun, 'id' | 'model'>[]; checks?: Omit<Check, 'id'>[]; events: [string, MissionEvent['type'], string][]; changes?: FileChange[]; reviews?: Omit<ProposalReview, 'id'>[];
  criteria?: string[]; approvedBy?: string; issueNumber?: number; error?: string; branchChange?: Mission['branchChange']; creatorId?: string;
}

function mission(generation: number, workspaceId: string, repositoryId: string, spec: MissionSpec): Mission {
  const id = demoUuid(generation, 'mission', spec.key);
  const runs = spec.runs.map((run, index) => ({ ...run, id: demoUuid(generation, 'run', spec.key, index), model: DEMO_MODEL }));
  const creatorId = spec.creatorId ?? 'demo-maya';
  const principal: Principal = { userId: creatorId, workspaceId, role: DEMO_USERS.find((user) => user.id === creatorId)!.role };
  return {
    id, repositoryId, title: spec.title, prompt: spec.prompt, status: spec.status, baseSha: spec.baseSha, candidateSha: spec.candidateSha, mode: 'combine', epoch: 1,
    runs,
    checks: (spec.checks ?? []).map((check, index) => ({ ...check, id: demoUuid(generation, 'check', spec.key, index), ...(check.runId ? { runId: runs[Number(check.runId)]?.id } : {}) })),
    events: spec.events.map(([timestamp, type, message], index) => ({ id: demoUuid(generation, 'event', spec.key, index), timestamp, type, message })),
    changes: (spec.changes ?? []).map((change) => ({ ...change, runIds: runs.filter((run) => run.changedFiles.includes(change.path)).map((run) => run.id) })),
    reviews: (spec.reviews ?? []).map((review, index) => ({ ...review, id: demoUuid(generation, 'review', spec.key, index) })),
    acceptanceCriteria: spec.criteria ?? [],
    authorization: { principal, workspaceId, creatorId },
    createdAt: spec.created, updatedAt: spec.updated,
    ...(spec.approvedBy ? { approvedBy: spec.approvedBy, approvedAt: spec.updated } : {}),
    ...(spec.issueNumber ? { issueNumber: spec.issueNumber } : {}),
    ...(spec.error ? { error: spec.error } : {}),
    ...(spec.branchChange ? { branchChange: spec.branchChange } : {}),
  };
}

const pad = (value: number) => String(value).padStart(6, '0');
function issueRecords(generation: number, repositoryId: string, issues: (Omit<Issue, 'repositoryId' | 'commentCount'> & { comments: Omit<IssueComment, 'id'>[] })[]): DemoRecord[] {
  const records: DemoRecord[] = [['issue-count', issues.length]];
  for (const { comments, ...issue } of issues) {
    records.push([`issue:${pad(issue.number)}`, { ...issue, repositoryId, commentCount: comments.length } satisfies Issue]);
    comments.forEach((comment, index) => {
      const key = `issue-comment:${pad(issue.number)}:${pad(index + 1)}`;
      records.push([key, { key, id: demoUuid(generation, 'comment', repositoryId, issue.number, index), ...comment }]);
    });
  }
  return records;
}

function release(generation: number, repositoryId: string, tag: string, name: string, notes: string, targetSha: string, at: string, authorId: string): DemoRecord {
  const id = demoUuid(generation, 'release', repositoryId, tag);
  return [`release:${id}`, { id, repositoryId, tag, name, notes, targetSha, draft: false, prerelease: false, authorId, createdAt: at, updatedAt: at, publishedAt: at } satisfies Release];
}

function repositoryRecord(workspaceId: string, generation: number, name: string, description: string, headSha: string, created: string, updated: string): Repository {
  const storageName = demoStorageName(workspaceId, name);
  return { id: demoUuid(generation, 'repository', name), workspaceId, name: storageName, displayName: name, description, defaultBranch: 'main', headSha, provider: 'artifacts', createdAt: created, updatedAt: updated };
}

const workerSource = {
  'package.json': `{\n  "name": "edge-store",\n  "private": true,\n  "type": "module",\n  "scripts": { "test": "node --test tests/" },\n  "devDependencies": { "wrangler": "^4.40.0" }\n}\n`,
  'wrangler.jsonc': `{\n  "name": "edge-store",\n  "main": "src/index.ts",\n  "compatibility_date": "2026-10-01",\n  "routes": [{ "pattern": "shop.example.com", "custom_domain": true }],\n  "env": {\n    "staging": { "name": "edge-store-staging", "workers_dev": true }\n  }\n}\n`,
  'README.md': '# edge-store\n\nA storefront that runs on Cloudflare Workers. Carts live in a Durable Object; checkout is idempotent.\n\n```sh\nnpm test\nnpx wrangler dev\n```\n',
  'src/index.ts': `import { addToCart, readCart } from './cart';\n\nexport default {\n  async fetch(request: Request): Promise<Response> {\n    const url = new URL(request.url);\n    if (url.pathname === '/cart' && request.method === 'GET') return Response.json(await readCart(request));\n    if (url.pathname === '/cart' && request.method === 'POST') return Response.json(await addToCart(request));\n    return new Response('edge-store', { status: 200 });\n  },\n};\n`,
  'src/cart.ts': `export interface CartLine { sku: string; quantity: number; unitCents: number }\n\nexport async function readCart(request: Request): Promise<CartLine[]> {\n  return JSON.parse(request.headers.get('x-cart') ?? '[]');\n}\n\nexport async function addToCart(request: Request): Promise<CartLine[]> {\n  const lines = await readCart(request);\n  const line = await request.json() as CartLine;\n  return [...lines.filter((item) => item.sku !== line.sku), line];\n}\n`,
};
const checkoutV1 = `import type { CartLine } from './cart';\n\nexport function total(lines: CartLine[]): number {\n  return lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0);\n}\n\nexport async function checkout(lines: CartLine[], charge: (cents: number) => Promise<string>): Promise<string> {\n  return charge(total(lines));\n}\n`;
const checkoutV2 = `import type { CartLine } from './cart';\n\nconst receipts = new Map<string, Promise<string>>();\n\nexport function total(lines: CartLine[]): number {\n  return lines.reduce((sum, line) => sum + line.quantity * line.unitCents, 0);\n}\n\nexport function checkout(key: string, lines: CartLine[], charge: (cents: number) => Promise<string>): Promise<string> {\n  const existing = receipts.get(key);\n  if (existing) return existing;\n  const receipt = charge(total(lines));\n  receipts.set(key, receipt);\n  return receipt;\n}\n`;
const checkoutTest = `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('totals cart lines', () => {\n  assert.equal([{ quantity: 2, unitCents: 450 }].reduce((sum, line) => sum + line.quantity * line.unitCents, 0), 900);\n});\n`;
const releaseSkill = `---\nname: release-notes\ndescription: Write release notes from landed proposals, grouped by user-facing change.\n---\n\n# Release notes\n\n1. List proposals landed since the previous tag.\n2. Group them as Added, Changed and Fixed.\n3. Link each line to its proposal.\n`;

function edgeStore(generation: number, workspaceId: string, c: Clock): DemoRepositoryPlan {
  const maya = people['demo-maya'], sam = people['demo-sam'], lena = people['demo-lena'];
  const history = buildDemoHistory({
    commits: [
      commit('init', undefined, 'Start edge-store Worker', maya, c.unix(30, 9), { ...workerSource }),
      commit('checkout', 'init', 'Add checkout totals', sam, c.unix(26, 14), { 'src/checkout.ts': checkoutV1 }),
      commit('tests', 'checkout', 'Test cart totals', sam, c.unix(24, 11), { 'tests/checkout.test.mjs': checkoutTest }),
      commit('skill', 'tests', 'Add release-notes agent skill', maya, c.unix(20, 16), { '.agents/skills/release-notes/SKILL.md': releaseSkill }),
      commit('retries', 'skill', 'Make checkout resilient to retries\n\nLanded from proposal "Make checkout resilient to retries".', agentPerson, c.unix(12, 15), { 'src/checkout.ts': checkoutV2 }),
      commit('limits', 'retries', 'Limit cart size to 50 lines', lena, c.unix(5, 10), { 'src/cart.ts': workerSource['src/cart.ts'].replace('return [...lines', "if (lines.length >= 50) throw new Error('Cart is full');\n  return [...lines") }),
      commit('gift', 'limits', 'Redeem gift cards at checkout', agentPerson, c.unix(1, 13), { 'src/gift-cards.ts': `export function redeem(balanceCents: number, totalCents: number): { charged: number; remaining: number } {\n  const used = Math.min(balanceCents, totalCents);\n  return { charged: totalCents - used, remaining: balanceCents - used };\n}\n` }),
      commit('cache', 'limits', 'Cache catalog responses (work in progress)', agentPerson, c.unix(0, 1), { 'src/catalog.ts': `export const CATALOG_TTL_SECONDS = 300;\n` }),
    ],
    refs: { 'refs/heads/main': 'limits', 'refs/heads/proposal/gift-cards': 'gift', 'refs/heads/feature/catalog-cache': 'cache', 'refs/tags/v1.0.0': 'tests', 'refs/tags/v1.1.0': 'retries' },
  });
  const s = history.shas;
  const repository = repositoryRecord(workspaceId, generation, 'edge-store', 'Storefront on Cloudflare Workers with idempotent checkout.', s.limits, c.iso(30, 9), c.iso(5, 10));
  const id = repository.id;
  const landed = mission(generation, workspaceId, id, {
    key: 'edge-retries', title: 'Make checkout resilient to retries', status: 'integrated', baseSha: s.skill, candidateSha: s.retries, created: c.iso(13, 9), updated: c.iso(12, 15), approvedBy: 'demo-maya', issueNumber: 1,
    prompt: 'Clients retry checkout after timeouts and are charged twice. Make checkout idempotent per request key without changing the cart API.',
    criteria: ['A repeated checkout key returns the first receipt', 'Totals are unchanged', 'Existing tests pass'],
    runs: [
      { name: 'idempotency', role: 'implementer', task: 'Store one receipt promise per checkout key.', status: 'completed', commitSha: s.retries, startedAt: c.iso(13, 9, 5), completedAt: c.iso(13, 9, 41), changedFiles: ['src/checkout.ts'], summary: 'Checkout now reuses the receipt for a repeated key.' },
      { name: 'tests', role: 'tester', task: 'Cover repeated checkout keys.', status: 'completed', startedAt: c.iso(13, 9, 5), completedAt: c.iso(13, 9, 37), changedFiles: [], summary: 'Existing tests cover totals; no new files needed.' },
    ],
    checks: [{ name: 'npm test', status: 'passed', candidateSha: s.retries, durationMs: 18_400, output: 'ok 1 - totals cart lines\n# pass 1\n# fail 0\n' }],
    changes: [patch('src/checkout.ts', ['export async function checkout(lines: CartLine[], charge: (cents: number) => Promise<string>): Promise<string> {', '  return charge(total(lines));'], ['export function checkout(key: string, lines: CartLine[], charge: (cents: number) => Promise<string>): Promise<string> {', '  const existing = receipts.get(key);', '  if (existing) return existing;', '  const receipt = charge(total(lines));', '  receipts.set(key, receipt);', '  return receipt;'])],
    reviews: [{ kind: 'comment', body: 'Should receipts expire? A Map grows forever in a long-lived isolate.', authorId: 'demo-omar', createdAt: c.iso(13, 11), epoch: 1, candidateSha: s.retries, baseSha: s.skill, path: 'src/checkout.ts', line: 3, side: 'new', resolvedAt: c.iso(12, 14), resolvedBy: 'demo-maya' }],
    events: [[c.iso(13, 9), 'info', 'Proposal started with 2 agents.'], [c.iso(13, 9, 41), 'success', 'Combined candidate passed npm test.'], [c.iso(12, 14, 30), 'success', 'Maya Chen approved the exact candidate.'], [c.iso(12, 15), 'success', `Landed ${s.retries.slice(0, 12)} on main.`]],
  });
  const review = mission(generation, workspaceId, id, {
    key: 'edge-gift', title: 'Redeem gift cards at checkout', status: 'needs_review', baseSha: s.limits, candidateSha: s.gift, created: c.iso(1, 11), updated: c.iso(1, 13, 20), issueNumber: 2,
    prompt: 'Let shoppers apply a gift card balance before charging the card. Report the remaining balance.',
    criteria: ['Balance never goes negative', 'Charged amount is total minus used balance'],
    runs: [
      { name: 'redeem', role: 'implementer', task: 'Add a pure redeem() helper.', status: 'completed', commitSha: s.gift, startedAt: c.iso(1, 11, 2), completedAt: c.iso(1, 12, 55), changedFiles: ['src/gift-cards.ts'], summary: 'Added redeem(balance, total).' },
      { name: 'review-notes', role: 'reviewer', task: 'Check rounding and negative balances.', status: 'completed', startedAt: c.iso(1, 11, 2), completedAt: c.iso(1, 12, 40), changedFiles: [], summary: 'Math.min keeps the balance non-negative.' },
    ],
    checks: [{ name: 'npm test', status: 'passed', candidateSha: s.gift, durationMs: 17_900, output: '# pass 1\n# fail 0\n' }],
    changes: [patch('src/gift-cards.ts', [], ['export function redeem(balanceCents: number, totalCents: number): { charged: number; remaining: number } {', '  const used = Math.min(balanceCents, totalCents);', '  return { charged: totalCents - used, remaining: balanceCents - used };', '}'])],
    reviews: [{ kind: 'comment', body: 'Can we add a test for a balance larger than the total?', authorId: 'demo-omar', createdAt: c.iso(1, 13, 10), epoch: 1, candidateSha: s.gift, baseSha: s.limits, path: 'src/gift-cards.ts', line: 2, side: 'new' }],
    events: [[c.iso(1, 11), 'info', 'Proposal started with 2 agents.'], [c.iso(1, 12, 58), 'success', 'Combined candidate passed npm test.'], [c.iso(1, 13, 20), 'info', 'Waiting for an Owner or Maintainer to approve the exact candidate.']],
  });
  const running = mission(generation, workspaceId, id, {
    key: 'edge-cache', title: 'Cache the product catalog at the edge', status: 'running', baseSha: s.limits, candidateSha: null, created: c.iso(0, 0, 50), updated: c.iso(0, 1, 5), creatorId: 'demo-sam',
    prompt: 'Serve /catalog from the Cache API for five minutes and purge it when products change.',
    runs: [
      { name: 'cache', role: 'implementer', task: 'Cache /catalog responses with a 300 second TTL.', status: 'running', startedAt: c.iso(0, 0, 52), changedFiles: ['src/catalog.ts'], note: 'Editing src/catalog.ts' },
      { name: 'purge', role: 'implementer', task: 'Purge the cached catalog on product updates.', status: 'queued', changedFiles: [] },
    ],
    checks: [{ name: 'npm test', status: 'pending' }],
    events: [[c.iso(0, 0, 50), 'info', 'Proposal started with 2 agents.'], [c.iso(0, 0, 52), 'info', 'Agent cache is working in its own fork.']],
  });
  const failed = mission(generation, workspaceId, id, {
    key: 'edge-wrangler', title: 'Move staging to a separate Workers account', status: 'failed', baseSha: s.limits, candidateSha: null, created: c.iso(3, 15), updated: c.iso(3, 15, 40), creatorId: 'demo-lena',
    error: 'The combined candidate failed npm test. Retry the failed agent with guidance or drop it.',
    prompt: 'Split staging into its own Wrangler environment with a distinct route and keep production unchanged.',
    runs: [
      { name: 'config', role: 'implementer', task: 'Add env.staging routes.', status: 'completed', startedAt: c.iso(3, 15, 2), completedAt: c.iso(3, 15, 20), changedFiles: ['wrangler.jsonc'], summary: 'Added a staging route.' },
      { name: 'docs', role: 'writer', task: 'Document the staging deploy.', status: 'failed', startedAt: c.iso(3, 15, 2), completedAt: c.iso(3, 15, 35), changedFiles: [], error: 'The agent stopped after editing a file outside its assignment.' },
    ],
    checks: [{ name: 'npm test', status: 'failed', durationMs: 9_200, output: 'not ok 1 - totals cart lines\n  error: Cannot find module src/checkout.ts\n# fail 1\n' }],
    events: [[c.iso(3, 15), 'info', 'Proposal started with 2 agents.'], [c.iso(3, 15, 35), 'error', 'Agent docs failed.'], [c.iso(3, 15, 40), 'error', 'Combined candidate failed npm test. Retry available.']],
  });
  const missions = [landed, review, running, failed];
  const targets = (workerName: string, configPath = 'wrangler.jsonc') => [{ workerName, configPath, d1Migrations: false }];
  const environment = (workerName: string, trigger: 'auto' | 'manual'): DeployEnvironmentSettings => ({ enabled: true, workerName, accountId: DEMO_ACCOUNT_ID, rollout: 'immediate', trigger, mode: 'deploy', targets: targets(workerName), authorizedBy: { userId: 'demo-lena', workspaceId, role: 'Deployer' }, updatedAt: c.iso(20, 12) });
  const settings: DeploySettings = { environments: { production: environment('edge-store', 'manual'), staging: environment('edge-store-staging', 'auto') } };
  const deployment = (key: string, env: 'production' | 'staging', commitSha: string, trigger: DeploymentRecord['trigger'], status: DeploymentRecord['status'], at: string, actorId: string, extra: Partial<DeploymentRecord> = {}): DeploymentRecord => {
    const workerName = env === 'production' ? 'edge-store' : 'edge-store-staging';
    const live = status === 'succeeded';
    const urls = env === 'production' ? ['https://shop.example.com'] : ['https://edge-store-staging.demo.workers.dev'];
    return {
      id: `${(Date.parse(at)).toString(36).padStart(9, '0')}-${demoUuid(generation, 'deployment', key)}`, attemptId: demoUuid(generation, 'attempt', key), repositoryId: id, workerName, accountId: DEMO_ACCOUNT_ID, environment: env, rollout: 'immediate', mode: 'deploy', commitSha, trigger, status, percentage: live ? 100 : 0, actorId, createdAt: at, updatedAt: at,
      targets: [{ workerName, configPath: 'wrangler.jsonc', d1Migrations: false, status: live ? 'succeeded' : status === 'failed' ? 'failed' : 'pending', percentage: live ? 100 : 0, ...(live ? { versionId: demoUuid(generation, 'version', key), urls } : {}), ...(status === 'failed' ? { errorCode: 'BUILD_FAILED', error: 'wrangler deploy --dry-run exited with code 1: Could not resolve "./checkout"' } : {}) }],
      ...(live ? { versionId: demoUuid(generation, 'version', key) } : {}),
      ...extra,
    };
  };
  const stagingRetries = deployment('staging-retries', 'staging', s.retries, 'land', 'succeeded', c.iso(12, 15, 5), 'demo-maya', { missionId: landed.id, baseSha: s.skill });
  const deployments = [
    stagingRetries,
    deployment('production-retries', 'production', s.retries, 'promote', 'succeeded', c.iso(11, 9), 'demo-visitor', { promotedFrom: stagingRetries.id }),
    deployment('staging-broken', 'staging', s.skill, 'manual', 'failed', c.iso(8, 16), 'demo-lena', { errorCode: 'BUILD_FAILED', error: 'wrangler deploy --dry-run exited with code 1: Could not resolve "./checkout"' }),
    deployment('staging-limits', 'staging', s.limits, 'land', 'succeeded', c.iso(5, 10, 6), 'demo-lena'),
    deployment('production-limits', 'production', s.limits, 'promote', 'awaiting_confirmation', c.iso(5, 11), 'demo-lena'),
  ];
  const preview: LastPreview = { candidateSha: s.gift, epoch: 1, kind: 'worker', previewUrl: null, readyAt: c.iso(1, 13, 25), expiresAt: c.iso(1, 14, 25), endedAt: c.iso(1, 14, 25), reason: 'expired' };
  const records: DemoRecord[] = [
    ...missions.map((item): DemoRecord => [`mission:${item.id}`, item]),
    ...issueRecords(generation, id, [
      { number: 1, title: 'Shoppers are charged twice after a timeout', body: 'When the payment call times out the client retries and we charge again.', state: 'closed', closedReason: 'completed', labels: ['bug', 'checkout'], assignees: ['demo-maya'], missionIds: [landed.id], authorId: 'demo-sam', createdAt: c.iso(14, 10), updatedAt: c.iso(12, 15), closedAt: c.iso(12, 15), comments: [{ authorId: 'demo-maya', body: 'Started a proposal with Fix with AI.', createdAt: c.iso(13, 9) }, { authorId: 'demo-sam', body: 'Confirmed on staging.', createdAt: c.iso(12, 16) }] },
      { number: 2, title: 'Gift card redemption', body: 'Apply a gift card balance before charging the card.', state: 'open', labels: ['feature'], assignees: [], missionIds: [review.id], authorId: 'demo-omar', createdAt: c.iso(2, 9), updatedAt: c.iso(1, 13), comments: [] },
      { number: 3, title: 'Catalog page is slow on cold starts', body: 'p95 is 900 ms from Singapore.', state: 'open', labels: ['performance'], assignees: ['demo-sam'], missionIds: [], authorId: 'demo-lena', createdAt: c.iso(4, 8), updatedAt: c.iso(4, 8), comments: [{ authorId: 'demo-omar', body: 'The Cache API should help here.', createdAt: c.iso(4, 12) }] },
    ]),
    release(generation, id, 'v1.0.0', 'edge-store 1.0', '## Added\n\n- Cart and checkout totals\n- Tests for cart totals\n', s.tests, c.iso(24, 12), 'demo-maya'),
    release(generation, id, 'v1.1.0', 'edge-store 1.1', '## Fixed\n\n- Checkout is idempotent per request key (proposal "Make checkout resilient to retries")\n', s.retries, c.iso(11, 10), 'demo-maya'),
    ['deploy-settings', settings],
    ...deployments.map((item): DemoRecord => [`deployment:${item.id}`, item]),
    [`preview-last:${review.id}`, preview],
  ];
  return { repository, history, records };
}

function billingApi(generation: number, workspaceId: string, c: Clock): DemoRepositoryPlan {
  const omar = people['demo-omar'], sam = people['demo-sam'];
  const invoiceV1 = `export function invoiceTotal(lines: { cents: number; taxRate: number }[]): number {\n  return Math.round(lines.reduce((sum, line) => sum + line.cents * (1 + line.taxRate), 0));\n}\n`;
  const invoiceV2 = `export function invoiceTotal(lines: { cents: number; taxRate: number }[]): number {\n  return lines.reduce((sum, line) => sum + Math.round(line.cents * (1 + line.taxRate)), 0);\n}\n`;
  const history = buildDemoHistory({
    commits: [
      commit('init', undefined, 'Start billing API', omar, c.unix(40, 10), { 'README.md': '# billing-api\n\nInvoices and tax for edge-store.\n', 'src/invoice.ts': invoiceV1, 'package.json': '{\n  "name": "billing-api",\n  "private": true,\n  "scripts": { "test": "node --test" }\n}\n' }),
      commit('rounding', 'init', 'Round invoice totals per line', agentPerson, c.unix(18, 12), { 'src/invoice.ts': invoiceV2 }),
      commit('webhooks', 'rounding', 'Verify payment webhook signatures', sam, c.unix(9, 15), { 'src/webhooks.ts': `export async function verify(secret: CryptoKey, body: string, signature: string): Promise<boolean> {\n  const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));\n  return crypto.subtle.verify('HMAC', secret, bytes, new TextEncoder().encode(body));\n}\n` }),
      commit('currency', 'webhooks', 'Format totals per currency', sam, c.unix(2, 11), { 'src/currency.ts': `export const format = (cents: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);\n` }),
    ],
    refs: { 'refs/heads/main': 'webhooks', 'refs/heads/fix/currency-format': 'currency', 'refs/tags/v0.4.0': 'rounding' },
  });
  const s = history.shas;
  const repository = repositoryRecord(workspaceId, generation, 'billing-api', 'Invoices, tax and payment webhooks.', s.webhooks, c.iso(40, 10), c.iso(9, 15));
  const id = repository.id;
  const landed = mission(generation, workspaceId, id, {
    key: 'billing-rounding', title: 'Round invoice totals per line', status: 'integrated', baseSha: s.init, candidateSha: s.rounding, created: c.iso(19, 9), updated: c.iso(18, 12), approvedBy: 'demo-omar', creatorId: 'demo-omar',
    prompt: 'Invoices differ from receipts by a cent. Round each line before summing.',
    runs: [{ name: 'rounding', role: 'implementer', task: 'Round per line.', status: 'completed', commitSha: s.rounding, startedAt: c.iso(19, 9, 3), completedAt: c.iso(19, 9, 30), changedFiles: ['src/invoice.ts'], summary: 'Rounds each line, then sums.' }],
    checks: [{ name: 'npm test', status: 'passed', candidateSha: s.rounding, durationMs: 6_100, output: '# pass 3\n# fail 0\n' }],
    changes: [patch('src/invoice.ts', ['  return Math.round(lines.reduce((sum, line) => sum + line.cents * (1 + line.taxRate), 0));'], ['  return lines.reduce((sum, line) => sum + Math.round(line.cents * (1 + line.taxRate)), 0);'])],
    events: [[c.iso(19, 9), 'info', 'Proposal started with 1 agent.'], [c.iso(18, 12), 'success', `Landed ${s.rounding.slice(0, 12)} on main.`]],
  });
  const pull = mission(generation, workspaceId, id, {
    key: 'billing-currency', title: 'Format totals per currency', status: 'needs_review', baseSha: s.webhooks, candidateSha: s.currency, created: c.iso(2, 11, 5), updated: c.iso(2, 11, 30), creatorId: 'demo-sam',
    prompt: 'Pull request from branch fix/currency-format.',
    branchChange: { branch: 'fix/currency-format', headSha: s.currency, targetBranch: 'main', description: 'Uses Intl.NumberFormat so invoices show the right currency symbol.' },
    runs: [],
    checks: [{ name: 'npm test', status: 'failed', candidateSha: s.currency, durationMs: 5_400, output: 'not ok 4 - formats JPY without decimals\n  expected: ¥1,200\n  actual: ¥12\n# fail 1\n' }],
    changes: [patch('src/currency.ts', [], ["export const format = (cents: number, currency: string) => new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);"])],
    reviews: [{ kind: 'request_changes', body: 'JPY has no minor unit, so dividing by 100 is wrong for it.', authorId: 'demo-omar', createdAt: c.iso(2, 12), epoch: 1, candidateSha: s.currency, baseSha: s.webhooks, path: 'src/currency.ts', line: 1, side: 'new' }],
    events: [[c.iso(2, 11, 5), 'info', 'Pull request opened from fix/currency-format.'], [c.iso(2, 11, 30), 'error', 'npm test failed on the exact head.']],
  });
  const records: DemoRecord[] = [
    [`mission:${landed.id}`, landed], [`mission:${pull.id}`, pull],
    ['branch-protection', { rules: [{ ...defaultBranchRule('main'), requiredApprovals: 1, requiredCheckNames: ['npm test'], preventSelfApproval: true }], updatedAt: c.iso(30, 9), updatedBy: 'demo-omar' }],
    ...issueRecords(generation, id, [{ number: 1, title: 'Support JPY invoices', body: 'Japanese customers see totals divided by 100.', state: 'open', labels: ['bug'], assignees: ['demo-sam'], missionIds: [], authorId: 'demo-omar', createdAt: c.iso(3, 9), updatedAt: c.iso(2, 12), comments: [{ authorId: 'demo-sam', body: 'Opened fix/currency-format.', createdAt: c.iso(2, 11, 6) }] }]),
    release(generation, id, 'v0.4.0', 'billing-api 0.4', '## Fixed\n\n- Invoice totals round per line\n', s.rounding, c.iso(17, 9), 'demo-omar'),
  ];
  return { repository, history, records };
}

function docsSite(generation: number, workspaceId: string, c: Clock): DemoRepositoryPlan {
  const maya = people['demo-maya'];
  const history = buildDemoHistory({
    commits: [
      commit('init', undefined, 'Start the docs site', maya, c.unix(60, 9), { 'README.md': '# docs-site\n\nProduct documentation built from Markdown.\n', 'docs/index.md': '# edge-store docs\n\nStart with [Checkout](checkout.md).\n' }),
      commit('checkout', 'init', 'Document idempotent checkout', maya, c.unix(11, 14), { 'docs/checkout.md': '# Checkout\n\nSend an `Idempotency-Key` header. A repeated key returns the first receipt.\n' }),
      commit('v2', 'checkout', 'Restructure navigation for 2.0', maya, c.unix(6, 10), { 'docs/index.md': '# edge-store docs\n\n- [Checkout](checkout.md)\n- [Gift cards](gift-cards.md)\n', 'docs/gift-cards.md': '# Gift cards\n\nComing soon.\n' }),
    ],
    refs: { 'refs/heads/main': 'v2', 'refs/tags/v2.0.0': 'v2' },
  });
  const s = history.shas;
  const repository = repositoryRecord(workspaceId, generation, 'docs-site', 'Markdown documentation for edge-store.', s.v2, c.iso(60, 9), c.iso(6, 10));
  const draft = mission(generation, workspaceId, repository.id, {
    key: 'docs-gift', title: 'Write the gift cards guide', status: 'draft', baseSha: s.v2, candidateSha: null, created: c.iso(0, 8), updated: c.iso(0, 8),
    prompt: 'Replace the placeholder gift cards page with a guide that matches the redeem() helper in edge-store.',
    runs: [{ name: 'writer', role: 'writer', task: 'Write docs/gift-cards.md.', status: 'draft', changedFiles: [] }],
    events: [[c.iso(0, 8), 'info', 'Draft saved. Agent runs are disabled in the demo.']],
  });
  return { repository, history, records: [[`mission:${draft.id}`, draft], release(generation, repository.id, 'v2.0.0', 'Docs 2.0', '## Changed\n\n- New navigation\n', s.v2, c.iso(6, 11), 'demo-maya')] };
}

function mcpExamples(generation: number, workspaceId: string, c: Clock): DemoRepositoryPlan {
  const sam = people['demo-sam'];
  const history = buildDemoHistory({
    commits: [
      commit('init', undefined, 'Add MCP connection examples', sam, c.unix(15, 10), {
        'README.md': '# mcp-examples\n\nConnect AI clients to Gitflare over MCP. Each client signs in through the browser and is limited to the access level you approve (read, write, land or admin).\n\n- `claude/` Claude Code\n- `codex/` Codex\n- `cursor/` Cursor\n\nIn this demo every MCP write returns DEMO_DISABLED; reads work.\n',
        'claude/README.md': '# Claude Code\n\n```sh\nclaude mcp add --transport http gitflare https://demo.gitflare.io/mcp\n```\n\nThen run `/mcp`, choose gitflare and authenticate in the browser.\n',
        'codex/README.md': '# Codex\n\n```sh\ncodex mcp add gitflare --url https://demo.gitflare.io/mcp\ncodex mcp login gitflare\n```\n',
        'cursor/mcp.json': '{\n  "mcpServers": {\n    "gitflare": { "url": "https://demo.gitflare.io/mcp" }\n  }\n}\n',
      }),
      commit('skill', 'init', 'Add a review skill for MCP clients', sam, c.unix(7, 16), { '.claude/skills/gitflare-review/SKILL.md': '---\nname: gitflare-review\ndescription: Review a Gitflare proposal through MCP before approving it.\n---\n\n# Review a proposal\n\n1. `gitflare_inspect_mission` with view `checks`, then `changes`.\n2. Compare the candidate and base SHAs you observed.\n3. Approve only on the user\'s instruction.\n' }),
    ],
    refs: { 'refs/heads/main': 'skill' },
  });
  const repository = repositoryRecord(workspaceId, generation, 'mcp-examples', 'MCP client configurations for Gitflare.', history.shas.skill, c.iso(15, 10), c.iso(7, 16));
  return { repository, history, records: issueRecords(generation, repository.id, [{ number: 1, title: 'Add a Zed example', body: 'Zed supports remote MCP servers now.', state: 'open', labels: ['docs'], assignees: [], missionIds: [], authorId: 'demo-visitor', createdAt: c.iso(1, 9), updatedAt: c.iso(1, 9), comments: [] }]) };
}

export function demoRunsPlan(generation: number, anchor: number): DemoRunsPlan {
  const workspaceId = demoWorkspaceId(generation);
  return neonDriftRuns({
    generation, workspaceId, anchor, uuid: demoUuid,
    repository: (name, description, headSha, created, updated) => repositoryRecord(workspaceId, generation, name, description, headSha, created, updated),
    people: { maya: people['demo-maya'], agent: agentPerson },
    principal: { userId: 'demo-maya', workspaceId, role: 'Maintainer' },
  });
}

function neonDrift(generation: number, anchor: number): DemoRepositoryPlan {
  const plan = demoRunsPlan(generation, anchor);
  return { repository: plan.repository, history: plan.history, records: [...plan.missions.map((item): DemoRecord => [`mission:${item.id}`, item]), ...plan.attempts] };
}

export function demoSeedPlan(generation: number, now: Date): DemoSeedPlan {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Demo generation must be a positive integer');
  const anchor = demoAnchor(now);
  const c = clock(anchor);
  const workspaceId = demoWorkspaceId(generation);
  const repositories = [edgeStore(generation, workspaceId, c), billingApi(generation, workspaceId, c), docsSite(generation, workspaceId, c), mcpExamples(generation, workspaceId, c), neonDrift(generation, anchor)];
  for (const plan of repositories) plan.records.unshift([`repository:${plan.repository.id}`, plan.repository]);
  const catalogRecords: DemoRecord[] = [
    ...repositories.map((plan): DemoRecord => [`repository:${plan.repository.id}`, plan.repository]),
    ...repositories.flatMap((plan) => plan.records.filter(([key]) => key.startsWith('mission:')).map(([key]): DemoRecord => [`mission-repository:${key.slice('mission:'.length)}`, plan.repository.id])),
  ];
  return { generation, anchor: new Date(anchor).toISOString(), workspaceId, workspaceName: DEMO_WORKSPACE_NAME, users: DEMO_USERS, repositories, catalogRecords };
}

export function demoPlanFingerprint(plan: DemoSeedPlan): string {
  return digest(JSON.stringify({ ...plan, repositories: plan.repositories.map(({ history, ...rest }) => ({ ...rest, shas: history.shas, refs: history.refs, packBytes: history.pack.byteLength })) }));
}

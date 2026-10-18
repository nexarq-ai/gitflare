export const DEMO_INSTALL_URL = 'https://gitflare.io/docs/install';

export type DemoFeatureId =
  | 'secrets' | 'github-mirror' | 'cloudflare' | 'cloudflare-resources' | 'deployments' | 'previews' | 'checks'
  | 'ai-models' | 'ai-keys' | 'ai-features' | 'people' | 'installation-credential' | 'mcp-clients' | 'repository-creation' | 'account-security';

export interface DemoFeature { name: string; summary: string; reason: string; docs: string }

export const DEMO_FEATURES: Record<DemoFeatureId, DemoFeature> = {
  secrets: { name: 'Repository secrets', summary: 'Links Cloudflare Secrets Store secrets to each environment so deploys and previews bind them without Gitflare ever storing a value.', reason: 'The demo has no Cloudflare account, so there is no Secrets Store to link.', docs: '/docs/cloudflare-permissions' },
  'github-mirror': { name: 'GitHub mirror', summary: 'Pushes every landing and push on the mirrored refs to a GitHub repository and stops a ref that diverges instead of overwriting it.', reason: 'The demo cannot store GitHub credentials or push to GitHub.', docs: '/docs/github-mirror' },
  cloudflare: { name: 'Cloudflare connection', summary: 'Authorizes your Cloudflare account so Gitflare can list its resources, deploy Workers and run previews in it.', reason: 'The demo is not connected to a Cloudflare account and cannot start OAuth.', docs: '/docs/cloudflare-permissions' },
  'cloudflare-resources': { name: 'Cloudflare resources', summary: 'Groups the Workers, D1 databases, Durable Objects and Workflows that belong to this repository and shows their usage.', reason: 'The demo has no Cloudflare account to read resources or usage from.', docs: '/docs/admin' },
  deployments: { name: 'Deployments', summary: 'Deploys landed commits to production and every Wrangler environment, with gradual rollouts, promotion, rollback and Cloudflare Access protection.', reason: 'The demo does not deploy to Cloudflare.', docs: '/docs/admin' },
  previews: { name: 'Preview settings', summary: 'Sets how long Worker previews live, who can open them and which addresses preview email may reach.', reason: 'The demo does not start previews.', docs: '/docs/repositories' },
  checks: { name: 'Check settings', summary: 'Sets the check time limit and runner size for new attempts, and when Gitflare raises them automatically.', reason: 'Repository settings are read-only in the shared demo.', docs: '/docs/repositories' },
  'ai-models': { name: 'AI models', summary: 'Chooses which AI Gateway and Workers AI models coding agents may use in this workspace.', reason: 'The demo does not run AI agents, so models cannot be added or verified.', docs: '/docs/agents' },
  'ai-keys': { name: 'AI keys and gateway', summary: 'Stores encrypted provider keys and an optional AI Gateway so inference runs on your own AI account.', reason: 'The demo never accepts provider keys.', docs: '/docs/agents' },
  'ai-features': { name: 'AI features', summary: 'Turns agents, mission drafting and AI client connections on or off for the whole workspace.', reason: 'AI settings are fixed in the shared demo.', docs: '/docs/agents' },
  people: { name: 'People and invitations', summary: 'Invites teammates, assigns roles and repository access, and issues bounded agent credentials.', reason: 'The demo cannot send email or change accounts and access.', docs: '/docs/admin' },
  'installation-credential': { name: 'Worker previews credential', summary: 'Gives this installation one Cloudflare credential so proposals of Worker apps get live previews and isolated D1 databases.', reason: 'The demo has no Cloudflare account to run previews in.', docs: '/docs/install' },
  'mcp-clients': { name: 'AI client connections', summary: 'Authorizes Claude, Codex, Cursor and other MCP clients to use the same workspace actions and permissions as the UI.', reason: 'Connecting clients to the shared demo workspace is turned off.', docs: '/docs/mcp' },
  'account-security': { name: 'Account security', summary: 'Manages your password, two-factor authentication and the browser and AI client sessions signed in to your account.', reason: 'Demo visitors share one credential-free account, so there is nothing to secure or revoke.', docs: '/docs/admin' },
  'repository-creation': { name: 'Repository creation', summary: 'Creates an isolated Git repository, imports one from a URL or connects an existing Artifacts repository.', reason: 'The shared demo keeps a fixed set of sample repositories.', docs: '/docs/repositories' },
};

export interface DemoDisabled { disabled: true; feature: DemoFeatureId; name: string; summary: string; reason: string; docs: string; install: string }

export type DemoExampleValue = string | number | boolean | null | string[];
export type DemoExampleRecord = Record<string, DemoExampleValue>;
export type DemoExamples = Record<string, DemoExampleRecord[]>;

export interface DemoMarked { demo?: DemoDisabled; examples?: DemoExamples }

export function demoDisabled(feature: DemoFeatureId): DemoDisabled {
  return { disabled: true, feature, ...DEMO_FEATURES[feature], install: DEMO_INSTALL_URL };
}

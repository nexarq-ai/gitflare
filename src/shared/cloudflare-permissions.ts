export const CLOUDFLARE_PERMISSIONS_DOCS_PATH = '/docs/cloudflare-permissions';

export type CloudflarePermissionGroup = 'Sign-in' | 'Connection' | 'Account and resources' | 'Data' | 'Deploys and previews' | 'Preview access' | 'Secrets' | 'Other';
export interface CloudflarePermission { scope: string; name: string; group: CloudflarePermissionGroup; reason: string }
export interface CloudflarePermissionPlan { scopes: string[]; permissions: CloudflarePermission[]; docsUrl: string }

type Entry = Omit<CloudflarePermission, 'scope'>;

export const CLOUDFLARE_PERMISSIONS: Readonly<Record<string, Entry>> = {
  'user-details.read': { name: 'User Details Read', group: 'Sign-in', reason: 'Read your Cloudflare user ID, name and email to sign you in.' },
  'offline_access': { name: 'Offline access', group: 'Connection', reason: 'Refresh the connection so resources and deploys keep working without re-authorizing every hour.' },
  'account-settings.read': { name: 'Account Settings Read', group: 'Account and resources', reason: 'List the accounts you granted so you can choose one for this workspace.' },
  'workers-scripts.metadata_read': { name: 'Workers Scripts Metadata Read', group: 'Account and resources', reason: 'List your Workers and Durable Object namespaces to link them to repositories.' },
  'workers-scripts.read': { name: 'Workers Scripts Read', group: 'Account and resources', reason: 'Read Worker details for the resources linked to a repository.' },
  'containers.read': { name: 'Containers Read', group: 'Account and resources', reason: 'List your Container applications to link them to repositories.' },
  'workflows.read': { name: 'Workflows Read', group: 'Account and resources', reason: 'List your Workflows to link them to repositories.' },
  'account-analytics.read': { name: 'Account Analytics Read', group: 'Account and resources', reason: 'Show request, error and query counts for linked Workers and D1 databases.' },
  'd1.read': { name: 'D1 Read', group: 'Data', reason: 'List your D1 databases to link them to repositories.' },
  'd1.write': { name: 'D1 Write', group: 'Data', reason: 'Apply D1 migrations an Owner reviewed and confirmed, and create databases a deploy declares.' },
  'workers-scripts.edit': { name: 'Workers Scripts Edit', group: 'Deploys and previews', reason: 'Upload and deploy your Workers and their previews when you land or deploy a change.' },
  'workers-scripts.admin': { name: 'Workers Admin', group: 'Deploys and previews', reason: 'Create Cloudflare Worker Previews of your Workers for proposals, and deploy them.' },
  'workers-r2.write': { name: 'Workers R2 Storage Write', group: 'Deploys and previews', reason: 'Create the R2 buckets a deployed Worker declares in its Wrangler configuration.' },
  'queues.write': { name: 'Queues Write', group: 'Deploys and previews', reason: 'Create the queues a deployed Worker produces to or consumes from.' },
  'workers-routes.write': { name: 'Workers Routes Write', group: 'Deploys and previews', reason: 'Attach the custom domains a deployed Worker declares.' },
  'zone.read': { name: 'Zone Read', group: 'Deploys and previews', reason: 'Look up the zone for a custom domain so you do not have to add zone_id to the route yourself.' },
  'ai.write': { name: 'Workers AI Write', group: 'Deploys and previews', reason: 'Bind Workers AI to a deployed Worker that declares it.' },
  'secrets-store.read': { name: 'Secrets Store Read', group: 'Secrets', reason: 'List the Secrets Store secrets you can link to a repository, by name only.' },
  'secrets-store.write': { name: 'Secrets Store Write', group: 'Secrets', reason: 'Create or rotate a secret you enter and bind linked secrets to your deployed Workers.' },
  'zone-access.read': { name: 'Access: Apps and Policies Read', group: 'Preview access', reason: 'Check the Cloudflare Access applications Gitflare put in front of your previews and deploy environments.' },
  'zone-access.write': { name: 'Access: Apps and Policies Write', group: 'Preview access', reason: 'Put Cloudflare Access in front of Worker previews and deploy environments when an Owner chooses it.' },
};

const ACCESS_ENTRY: Entry = { name: 'Access: Apps and Policies Write', group: 'Preview access', reason: 'Put Cloudflare Access in front of Worker previews and deploy environments when an Owner chooses it.' };

export function describeCloudflareScopes(scopes: string[], accessScopes: string[] = []): CloudflarePermission[] {
  return [...new Set(scopes)].map(scope => ({ scope, ...(CLOUDFLARE_PERMISSIONS[scope] ?? (accessScopes.includes(scope) ? ACCESS_ENTRY : { name: scope, group: 'Other', reason: 'Requested by this installation’s configuration. Ask its operator what it is used for.' })) }));
}

export function cloudflarePermissionGroups(permissions: CloudflarePermission[]): { group: CloudflarePermissionGroup; permissions: CloudflarePermission[] }[] {
  const groups = new Map<CloudflarePermissionGroup, CloudflarePermission[]>();
  for (const permission of permissions) groups.set(permission.group, [...(groups.get(permission.group) ?? []), permission]);
  return [...groups].map(([group, items]) => ({ group, permissions: items }));
}

export type CloudflareFeature = 'deploy' | 'previews' | 'secrets' | 'access';
export const CLOUDFLARE_FEATURES: readonly CloudflareFeature[] = ['deploy', 'previews', 'secrets', 'access'];
export const WORKERS_SCRIPTS_EDIT = 'workers-scripts.edit';
export const WORKERS_SCRIPTS_ADMIN = 'workers-scripts.admin';
export interface CloudflareFeatureEnv { CLOUDFLARE_DEPLOY_SCOPES?: string; CLOUDFLARE_PREVIEWS_SCOPES?: string; CLOUDFLARE_SECRETS_SCOPES?: string; CLOUDFLARE_ACCESS_SCOPES?: string }
export interface CloudflareFeatureState { feature: CloudflareFeature; scopes: string[]; granted: boolean; missing: string[] }

const FEATURE_DEFAULTS: Record<CloudflareFeature, string> = {
  deploy: 'workers-scripts.edit d1.write',
  previews: 'workers-scripts.admin d1.write',
  secrets: 'secrets-store.read secrets-store.write',
  access: 'zone-access.write zone-access.read',
};
const FEATURE_ENV: Record<CloudflareFeature, keyof CloudflareFeatureEnv> = { deploy: 'CLOUDFLARE_DEPLOY_SCOPES', previews: 'CLOUDFLARE_PREVIEWS_SCOPES', secrets: 'CLOUDFLARE_SECRETS_SCOPES', access: 'CLOUDFLARE_ACCESS_SCOPES' };
const IMPLIED_BY: Record<string, string[]> = { [WORKERS_SCRIPTS_EDIT]: [WORKERS_SCRIPTS_ADMIN] };

function scopeWords(value: string): string[] { return [...new Set(value.split(/\s+/).filter(scope => scope && scope !== 'openid'))]; }

export function featureScopes(env: CloudflareFeatureEnv, feature: CloudflareFeature): string[] {
  return scopeWords(env[FEATURE_ENV[feature]] ?? FEATURE_DEFAULTS[feature]);
}

export function hasScope(granted: readonly string[], scope: string): boolean {
  return granted.includes(scope) || (IMPLIED_BY[scope] ?? []).some(other => granted.includes(other));
}

export function missingScopes(granted: readonly string[], required: readonly string[]): string[] {
  return required.filter(scope => !hasScope(granted, scope));
}

export function featureStates(env: CloudflareFeatureEnv, granted: readonly string[] | null): CloudflareFeatureState[] {
  return CLOUDFLARE_FEATURES.map(feature => {
    const scopes = featureScopes(env, feature);
    const missing = granted ? missingScopes(granted, scopes) : scopes;
    return { feature, scopes, granted: !!granted && scopes.length > 0 && !missing.length, missing };
  });
}

export function parseCloudflareFeatures(value: unknown): CloudflareFeature[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > CLOUDFLARE_FEATURES.length || value.some(item => !CLOUDFLARE_FEATURES.includes(item as CloudflareFeature))) return null;
  return [...new Set(value as CloudflareFeature[])];
}

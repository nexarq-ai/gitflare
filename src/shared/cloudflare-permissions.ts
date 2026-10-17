export const CLOUDFLARE_PERMISSIONS_DOCS_PATH = '/docs/cloudflare-permissions';

export type CloudflarePermissionGroup = 'Sign-in' | 'Connection' | 'Account and resources' | 'Data' | 'Deploys and previews' | 'Preview access' | 'Other';
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
  'workers-r2.write': { name: 'Workers R2 Storage Write', group: 'Deploys and previews', reason: 'Create the R2 buckets a deployed Worker declares in its Wrangler configuration.' },
  'queues.write': { name: 'Queues Write', group: 'Deploys and previews', reason: 'Create the queues a deployed Worker produces to or consumes from.' },
  'workers-routes.write': { name: 'Workers Routes Write', group: 'Deploys and previews', reason: 'Attach the custom domains a deployed Worker declares.' },
  'zone.read': { name: 'Zone Read', group: 'Deploys and previews', reason: 'Look up the zone for a custom domain so you do not have to add zone_id to the route yourself.' },
  'ai.write': { name: 'Workers AI Write', group: 'Deploys and previews', reason: 'Bind Workers AI to a deployed Worker that declares it.' },
};

const ACCESS_ENTRY: Entry = { name: 'Access: Apps and Policies Edit', group: 'Preview access', reason: 'Put Cloudflare Access in front of Worker previews when a repository chooses it.' };

export function describeCloudflareScopes(scopes: string[], accessScopes: string[] = []): CloudflarePermission[] {
  return [...new Set(scopes)].map(scope => ({ scope, ...(CLOUDFLARE_PERMISSIONS[scope] ?? (accessScopes.includes(scope) ? ACCESS_ENTRY : { name: scope, group: 'Other', reason: 'Requested by this installation’s configuration. Ask its operator what it is used for.' })) }));
}

export function cloudflarePermissionGroups(permissions: CloudflarePermission[]): { group: CloudflarePermissionGroup; permissions: CloudflarePermission[] }[] {
  const groups = new Map<CloudflarePermissionGroup, CloudflarePermission[]>();
  for (const permission of permissions) groups.set(permission.group, [...(groups.get(permission.group) ?? []), permission]);
  return [...groups].map(([group, items]) => ({ group, permissions: items }));
}

import overview from '../../docs/public/overview.md?raw';
import install from '../../docs/public/install.md?raw';
import admin from '../../docs/public/admin.md?raw';
import repositories from '../../docs/public/repositories.md?raw';
import mcp from '../../docs/public/mcp.md?raw';
import agents from '../../docs/public/agents.md?raw';
import cloudflarePermissions from '../../docs/public/cloudflare-permissions.md?raw';
import githubMirror from '../../docs/public/github-mirror.md?raw';
import type { DocMetadata, ProductDoc } from './docs';
import { errorResponse } from './domain';

const publicDocuments: ProductDoc[] = [
  { id: 'overview', title: 'How Gitflare works', description: 'Missions, review, landing and editions.', audience: 'human', filename: 'overview.md', content: overview },
  { id: 'install', title: 'Install on Cloudflare', description: 'Deploy into your own Cloudflare account.', audience: 'technical', filename: 'install.md', content: install },
  { id: 'admin', title: 'Workspace administration', description: 'Users, roles, MFA and credentials.', audience: 'human', filename: 'admin.md', content: admin },
  { id: 'cloudflare-permissions', title: 'Cloudflare permissions', description: 'What sign-in and account connection request, and why.', audience: 'human', filename: 'cloudflare-permissions.md', content: cloudflarePermissions },
  { id: 'repositories', title: 'Repositories and changes', description: 'Browse, check, review and land.', audience: 'human', filename: 'repositories.md', content: repositories },
  { id: 'github-mirror', title: 'Mirror to GitHub', description: 'Keep GitHub as a downstream copy.', audience: 'human', filename: 'github-mirror.md', content: githubMirror },
  { id: 'mcp', title: 'Connect through MCP', description: 'Authenticated tools for AI clients.', audience: 'agent', filename: 'mcp.md', content: mcp },
  { id: 'agents', title: 'AI client and agent guide', description: 'Rules for AI clients and coding agents.', audience: 'agent', filename: 'agents.md', content: agents },
];

export function listPublicDocs(): DocMetadata[] {
  return publicDocuments.map(({ content: _content, ...metadata }) => metadata);
}

export function readPublicDoc(id: string): ProductDoc | undefined {
  const document = publicDocuments.find((item) => item.id === id);
  return document ? { ...document } : undefined;
}

export async function publicSourceResponse(_request: Request, _assets: Fetcher): Promise<Response> { return errorResponse(404, 'NOT_FOUND', 'This source endpoint does not exist.'); }

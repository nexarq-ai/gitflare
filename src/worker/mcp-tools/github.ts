import { z } from 'zod';
import { ApiError } from '../domain';
import { ORG_IMPORT_MAX } from '../github-import';
import type { McpServer } from '@modelcontextprotocol/server';
import { identifier, repositoryId, requestKey, readOnly, external } from '../mcp-schemas';
import { guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call, origin }: McpToolContext): void {
  server.registerTool('gitflare_github_mirror', {
    title: 'Read a repository’s GitHub mirror', description: 'Read a repository’s GitHub mirror: target, ref patterns, credential kind (never its value), sync state and per-ref Gitflare/GitHub/last synced SHAs, times, errors and divergence. Gitflare is the source of truth. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/github-mirror`)));
  server.registerTool('gitflare_manage_github_mirror', {
    title: 'Manage a repository’s GitHub mirror', description: 'Owner-only: link (owner, name, ref_patterns), unlink, sync, app-installation, remove-credential. credential-setup returns a browser URL; tokens never pass through MCP. A diverged ref has GitHub commits Gitflare lacks: import copies it to a github-import/ stream; overwrite replaces it if expected_github_sha still matches (audited). adopt imports GitHub once into an empty repository. Needs admin access.',
    inputSchema: z.object({
      repository_id: repositoryId,
      action: z.enum(['link', 'unlink', 'credential-setup', 'app-installation', 'remove-credential', 'sync', 'import', 'overwrite', 'adopt']),
      owner: z.string().min(1).max(39).optional().describe('GitHub user or organization, for link.'),
      name: z.string().min(1).max(100).optional().describe('GitHub repository name, for link.'),
      ref_patterns: z.array(z.string().min(1).max(220)).min(1).max(20).optional().describe('For link: refs to mirror, such as refs/heads/main and refs/tags/*.'),
      installation_id: z.number().int().positive().optional().describe('GitHub App installation ID, for app-installation.'),
      ref: z.string().max(220).optional().describe('Full ref for import and overwrite, such as refs/heads/main.'),
      expected_github_sha: z.string().regex(/^[a-f0-9]{40}$/).nullable().optional().describe('For overwrite: the GitHub SHA shown in gitflare_github_mirror for this ref, or null if GitHub has no such ref.'),
      idempotency_key: requestKey,
    }).strict(), annotations: { ...external, destructiveHint: true, idempotentHint: false },
  }, (input) => guarded(async () => {
    const path = `/api/repositories/${input.repository_id}/github-mirror`;
    if (input.action === 'credential-setup') {
      const status = await call<{ canManage?: boolean; mirror?: unknown }>(path);
      return { browserStartUrl: `${origin}/repository/${encodeURIComponent(input.repository_id)}/settings/branches#github-mirror`, browserEntryRequired: true, canManage: status.canManage, linked: !!status.mirror };
    }
    const body = input.action === 'link' ? { owner: input.owner, name: input.name, ...(input.ref_patterns ? { refPatterns: input.ref_patterns } : {}) }
      : input.action === 'app-installation' ? { kind: 'app', installationId: input.installation_id }
      : input.action === 'import' ? { ref: input.ref }
      : input.action === 'overwrite' ? { ref: input.ref, expectedGithubSha: input.expected_github_sha === undefined ? undefined : input.expected_github_sha }
      : {};
    const action = input.action === 'app-installation' ? 'credential' : input.action;
    return call<Record<string, unknown>>(`${path}/${action}`, body, input.idempotency_key);
  }));
  const githubOwner = z.string().min(1).max(39).describe('GitHub user or organization.');
  const importOptions = {
    issues: z.boolean().optional().describe('Import issues, labels and comments (default true).'),
    pull_requests: z.boolean().optional().describe('Import open pull requests as proposals and closed ones as history (default true).'),
    releases: z.boolean().optional().describe('Import release notes for tags already in the repository (default true).'),
  };
  server.registerTool('gitflare_github_import', {
    title: 'Read a repository’s GitHub import', description: 'Read the GitHub data import for a repository: source, phase, counts, skipped items with reasons, rate-limit wait, credential kind (never its value), hourly issue pull and whether Gitflare is canonical. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/github-import`)));
  server.registerTool('gitflare_import_github', {
    title: 'Import issues, pull requests and releases from GitHub', description: 'Owner-only. start imports labels, issues, comments, open pull requests (as draft proposals) and releases from GitHub; private repositories need the mirror credential or a token added in the browser (credential-setup returns the URL; tokens never pass through MCP). resume, cancel, transition-on/off (hourly issue pull), pull (now), canonical (notify opens a GitHub notice). Needs admin access.',
    inputSchema: z.object({
      repository_id: repositoryId,
      action: z.enum(['start', 'resume', 'cancel', 'pull', 'transition-on', 'transition-off', 'canonical', 'credential-setup', 'remove-credential']),
      owner: githubOwner.optional().describe('GitHub user or organization, for start.'),
      name: z.string().min(1).max(100).optional().describe('GitHub repository name, for start.'),
      ...importOptions,
      credential: z.enum(['none', 'mirror', 'stored']).optional().describe('For start: none (public repositories), mirror (the linked GitHub mirror credential) or stored (a token added earlier in the browser).'),
      keep_credential: z.boolean().optional().describe('For start: keep the token after the import for the hourly issue pull.'),
      notify: z.boolean().optional().describe('For canonical: open an issue on GitHub pointing to Gitflare. Needs a token with Issues write access.'),
      idempotency_key: requestKey,
    }).strict(), annotations: { ...external, destructiveHint: true, idempotentHint: false },
  }, (input) => guarded(async () => {
    const path = `/api/repositories/${input.repository_id}/github-import`;
    if (input.action === 'credential-setup') {
      const status = await call<{ canManage?: boolean; job?: unknown }>(path);
      return { browserStartUrl: `${origin}/repository/${encodeURIComponent(input.repository_id)}/settings#github-import`, browserEntryRequired: true, canManage: status.canManage, started: !!status.job };
    }
    const body = input.action === 'start' ? { owner: input.owner, name: input.name, issues: input.issues, pullRequests: input.pull_requests, releases: input.releases, credential: input.credential ?? 'none', keepCredential: input.keep_credential }
      : input.action === 'transition-on' || input.action === 'transition-off' ? { enabled: input.action === 'transition-on' }
      : input.action === 'canonical' ? { notify: input.notify ?? false }
      : {};
    const action = input.action.startsWith('transition-') ? 'transition' : input.action;
    return call<Record<string, unknown>>(`${path}/${action}`, body, input.idempotency_key);
  }));
  server.registerTool('gitflare_github_organization', {
    title: 'List GitHub organization repositories and imports', description: 'repositories lists a GitHub organization’s or user’s public repositories (100 a page; private ones need a token in the browser at /import/github). imports lists this workspace’s recent organization imports; import reads one with each repository’s code and data progress. Owner-only for repositories. Read-only.',
    inputSchema: z.object({ view: z.enum(['repositories', 'imports', 'import']), owner: githubOwner.optional().describe('For repositories.'), page: z.number().int().min(1).max(100).optional(), import_id: identifier.optional().describe('For import.') }).strict(), annotations: { ...readOnly, openWorldHint: true },
  }, (input) => guarded(async () => {
    if (input.view === 'repositories') {
      if (!input.owner) throw new ApiError(400, 'INVALID_INPUT', 'Pass owner.');
      return call<Record<string, unknown>>('/api/github-import/organizations/repositories', { owner: input.owner, page: input.page ?? 1 });
    }
    if (input.view === 'import') {
      if (!input.import_id) throw new ApiError(400, 'INVALID_INPUT', 'Pass import_id.');
      return call<Record<string, unknown>>(`/api/github-import/organizations/${input.import_id}`);
    }
    return call<Record<string, unknown>>('/api/github-import/organizations');
  }));
  server.registerTool('gitflare_import_github_organization', {
    title: 'Import repositories from a GitHub organization', description: `Owner-only. Creates one Gitflare repository per chosen GitHub repository (up to ${ORG_IMPORT_MAX}), imports its code with full history, then its issues, pull requests and releases. Public repositories only over MCP; private ones need a token added in the browser at /import/github. Follow progress with gitflare_github_organization. Needs admin access.`,
    inputSchema: z.object({ owner: githubOwner, repositories: z.array(z.string().min(1).max(100)).min(1).max(ORG_IMPORT_MAX), ...importOptions, idempotency_key: requestKey }).strict(), annotations: { ...external, idempotentHint: true },
  }, (input) => guarded(async () => call<Record<string, unknown>>('/api/github-import/organizations', { owner: input.owner, repositories: input.repositories, issues: input.issues, pullRequests: input.pull_requests, releases: input.releases }, input.idempotency_key)));
}

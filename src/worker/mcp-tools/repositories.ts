import { IMPORT_ZIP_MAX_BYTES } from '../repository-import';
import type { RepositorySkills } from '../repository-skills';
import { z } from 'zod';
import type { Mission, Repository, RepositoryFile, RepositoryTree, Workspace } from '../../shared/types';
import { ApiError, repositoryPath, repositoryRef } from '../domain';
import { mutableSkillPath, SKILL_CONTENT_MAX_BYTES } from '../skill-edit';
import { URL_IMPORT_LIMITS } from '../url-import';
import type { McpServer } from '@modelcontextprotocol/server';
import { identifier, repositoryId, requestKey, offset, pageLimit, gitRef, filePath, repositoryInput, readOnly, mutation, commit } from '../mcp-schemas';
import { excerpt, page, missionSummary, guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_list_repositories', {
    title: 'List Gitflare repositories', description: 'List the repositories you can read, with IDs, default branch and head commit, plus workspace mode and integrations. Start here to find repository IDs. Read-only.',
    inputSchema: z.object({ offset, limit: pageLimit }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const workspace = await call<Workspace>('/api/workspace');
    return { workspace: workspace.name, mode: workspace.mode, integrations: workspace.integrations, ...page(workspace.repositories, input.offset, input.limit) };
  }));
  server.registerTool('gitflare_browse_repository', {
    title: 'Browse repository source', description: 'List one directory at a branch, tag or commit, including a mission candidate commit (combined or race, even one held only in its fork) when you may read that mission. Returns the resolved commit SHA; pass it as ref to later reads so evidence stays consistent. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, ref: gitRef.default('main'), path: filePath.default(''), offset, limit: pageLimit }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const query = new URLSearchParams({ ref: repositoryRef(input.ref), path: repositoryPath(input.path) });
    const tree = await call<RepositoryTree>(`/api/repositories/${input.repository_id}/tree?${query}`);
    return { ref: tree.ref, commitSha: tree.commitSha, ...(tree.missionId ? { missionId: tree.missionId, source: tree.source } : {}), ...page(tree.entries, input.offset, input.limit) };
  }));
  server.registerTool('gitflare_list_repository_skills', {
    title: 'List repository skills', description: 'Find SKILL.md files under .agents/skills, .claude/skills, skills and docs/skills at one commit, with names, descriptions and paths. Read them with gitflare_read_file at the returned commitSha. Read-only; nothing is installed or run.',
    inputSchema: z.object({ repository_id: repositoryId, ref: gitRef.optional(), offset, limit: pageLimit }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const query = new URLSearchParams(input.ref ? { ref: repositoryRef(input.ref) } : {});
    const result = await call<RepositorySkills>(`/api/repositories/${input.repository_id}/skills?${query}`);
    const { skills, ...metadata } = result;
    return { ...metadata, ...page(skills, input.offset, input.limit) };
  }));
  for (const action of ['create', 'update'] as const) {
    server.registerTool(`gitflare_${action}_repository_skill`, {
      title: action === 'create' ? 'Create a repository skill proposal' : 'Update a repository skill proposal',
      description: `${action === 'create' ? 'Create' : 'Update'} docs/skills/<slug>/SKILL.md as a reviewable proposal at the observed base commit. Runs repository checks; nothing reaches the default branch until approved and landed. Content needs name and description frontmatter, up to 64 KiB. Needs contribute permission and write access.`,
      inputSchema: z.object({ repository_id: repositoryId, path: z.string().regex(mutableSkillPath).describe('docs/skills/<lowercase-slug>/SKILL.md'), content: z.string().min(1).max(SKILL_CONTENT_MAX_BYTES).describe('Full SKILL.md Markdown with name and description frontmatter.'), base_sha: commit.describe('Default-branch head you read the skill at.'), idempotency_key: requestKey }).strict(), annotations: mutation,
    }, input => guarded(async () => missionSummary(await call<Mission>(`/api/repositories/${input.repository_id}/skills`, { action, path: input.path, content: input.content, baseSha: input.base_sha }, input.idempotency_key))));
  }
  server.registerTool('gitflare_read_file', {
    title: 'Read a source file', description: 'Read a text file at a branch, tag or commit in pages of up to limit characters; follow nextOffset for more. Mission candidate commits (combined or race, even fork-held) resolve when you may read that mission; use this for whole files the changes view truncates. Binary files and files over 512 KB are refused. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, ref: gitRef.default('main'), path: z.string().min(1).max(2000).describe('Path relative to the repository root.'), offset, limit: z.number().int().min(1).max(12_000).default(6000).describe('Characters to return.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const query = new URLSearchParams({ ref: repositoryRef(input.ref), path: repositoryPath(input.path, false) });
    const file = await call<RepositoryFile>(`/api/repositories/${input.repository_id}/file?${query}`);
    return { path: file.path, commitSha: file.commitSha, ...(file.missionId ? { missionId: file.missionId, source: file.source } : {}), ...excerpt(file.content, input.offset, input.limit) };
  }));
}

export function registerSetup(server: McpServer, { call, origin }: McpToolContext): void {
  server.registerTool('gitflare_repository_import_status', {
    title: 'Inspect first code import readiness', description: 'Check whether a repository can take a first code import: returns its head and whether it is empty or holds only the untouched bootstrap commit. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId }).strict(), annotations: readOnly,
  }, input => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/import`)));
  server.registerTool('gitflare_import_repository_archive', {
    title: 'Import existing code from a ZIP archive', description: 'Import a base64 ZIP archive as the first code commit of an empty or freshly bootstrapped repository. Writes the default branch directly; secrets, .git, dependencies and build caches are dropped. Pass the observed head (null when empty) and replay the same key to reconcile an uncertain result. Needs the Owner role and land access.',
    inputSchema: z.object({ repository_id: repositoryId, archive_base64: z.string().min(1).max(Math.ceil(IMPORT_ZIP_MAX_BYTES / 3) * 4).describe('Base64-encoded ZIP archive.'), expected_head_sha: commit.nullable().describe('Head from gitflare_repository_import_status; null for an empty repository.'), message: z.string().min(1).max(200).optional().describe('Commit message.'), idempotency_key: requestKey }).strict(), annotations: mutation,
  }, input => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/import`, { archiveBase64: input.archive_base64, expectedHeadSha: input.expected_head_sha, ...(input.message ? { message: input.message } : {}) }, input.idempotency_key)));
  server.registerTool('gitflare_create_repository', {
    title: 'Create a repository', description: 'Create an empty repository in this workspace, optionally with a README, .gitignore and license. Does not import code or start agents; use a new idempotency key per repository. Needs the Owner role and write access.',
    inputSchema: z.object(repositoryInput).strict(), annotations: mutation,
  }, ({ idempotency_key, ...input }) => guarded(async () => ({ repository: await call<Repository>('/api/repositories', input, idempotency_key) })));
  server.registerTool('gitflare_connect_repository', {
    title: 'Connect an existing repository', description: 'Register an existing repository from this installation’s Artifacts namespace in the legacy workspace. Does not import external repositories. Needs the Owner role and write access.',
    inputSchema: z.object(repositoryInput).strict(), annotations: mutation,
  }, ({ idempotency_key, ...input }) => guarded(async () => ({ repository: await call<Repository>('/api/repositories/connect', input, idempotency_key) })));
  server.registerTool('gitflare_import_repository_url', {
    title: 'Import a repository from a Git URL', description: `Create a repository and import every branch and tag with full history from a public HTTPS Git URL (GitHub, GitLab, Bitbucket, others), or retry a failed import. Runs in the background; follow it with gitflare_url_import_status. A source that needs a token returns a browser URL where the Owner enters it. Up to ${URL_IMPORT_LIMITS.packBytes / 1024 / 1024} MiB; no SSH or LFS. Needs Manage permission and land access.`,
    inputSchema: z.object({ action: z.enum(['start', 'retry']).default('start'), url: z.string().min(1).max(2048).optional().describe('Required for start.'), name: z.string().min(1).max(64).optional(), description: z.string().max(500).optional(), repository_id: identifier.optional().describe('Required for retry.'), requires_credentials: z.boolean().optional().describe('true when the source is private; returns a browser URL instead of importing.'), idempotency_key: requestKey }).strict(), annotations: { ...mutation, idempotentHint: false, openWorldHint: true },
  }, ({ action, repository_id, idempotency_key, url, name, description, requires_credentials }) => guarded(async () => {
    if (action === 'retry' && !repository_id) throw new ApiError(400, 'INVALID_INPUT', 'Provide repository_id.');
    if (action === 'start' && !url) throw new ApiError(400, 'INVALID_INPUT', 'Provide url.');
    if (requires_credentials) return { browserStartUrl: action === 'retry' ? `${origin}/repository/${encodeURIComponent(repository_id!)}/import` : `${origin}/repositories`, browserEntryRequired: true };
    if (action === 'retry') return { repository: await call<Repository>(`/api/repositories/${repository_id}/import-url/retry`, {}, idempotency_key) };
    return { repository: await call<Repository>('/api/repositories/import-url', { url, ...(name ? { name } : {}), ...(description ? { description } : {}) }, idempotency_key) };
  }));
  server.registerTool('gitflare_url_import_status', {
    title: 'Read Git URL import progress', description: 'Read the background import state of a repository created from a Git URL, including any failure to retry. Read-only.',
    inputSchema: z.object({ repository_id: identifier }).strict(), annotations: readOnly,
  }, ({ repository_id }) => guarded(async () => call<Record<string, unknown>>(`/api/repositories/${repository_id}/import-url`)));
}

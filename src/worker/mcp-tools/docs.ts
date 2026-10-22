import { z } from 'zod';
import { repositoryPath } from '../domain';
import type { DocMetadata, ProductDoc } from '../docs';
import type { McpServer } from '@modelcontextprotocol/server';
import { identifier, offset, filePath, readOnly } from '../mcp-schemas';
import { excerpt, page, guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_list_docs', {
    title: 'List Gitflare documentation', description: 'List Gitflare documentation pages; set public to list only the public guides. Planning pages describe intent, not shipped features. Read-only.',
    inputSchema: z.object({ public: z.boolean().default(false).describe('List only the public guides.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => call<{ items: DocMetadata[] }>(input.public ? '/api/public/docs' : '/api/docs')));
  server.registerTool('gitflare_read_doc', {
    title: 'Read Gitflare documentation', description: 'Read a documentation page as Markdown in pages of up to limit characters; follow nextOffset for more. Read-only.',
    inputSchema: z.object({ doc_id: identifier.describe('Document ID from gitflare_list_docs.'), public: z.boolean().default(false).describe('Read from the public guides.'), offset, limit: z.number().int().min(1).max(12000).default(8000).describe('Characters to return.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const { content, ...metadata } = await call<ProductDoc>(`${input.public ? '/api/public/docs' : '/api/docs'}/${input.doc_id}`);
    return { ...metadata, content: excerpt(content, input.offset, input.limit) };
  }));
  server.registerTool('gitflare_public_source', {
    title: 'Browse the public self-hosted source', description: 'Read the Apache-2.0 open-source release this installation publishes: manifest, file tree, README, one file, or commit history (pass path for that file’s last commit). Read-only; standalone installations may publish nothing.',
    inputSchema: z.object({ view: z.enum(['manifest', 'tree', 'readme', 'file', 'repository']).default('manifest').describe('What to read; tree and file use path.'), path: filePath.default(''), offset, limit: z.number().int().min(1).max(12000).default(8000) }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const suffix = input.view === 'manifest' ? '' : input.view === 'repository' ? '/repository' : `/${input.view}?${new URLSearchParams({ path: repositoryPath(input.path) })}`;
    const source = await call<Record<string, unknown>>(`/api/public/source${suffix}`);
    if (input.view === 'repository') {
      const { files, commits, ...metadata } = source;
      const fileMap = files && typeof files === 'object' && !Array.isArray(files) ? files as Record<string, unknown> : {};
      const path = input.path ? repositoryPath(input.path) : '';
      return { ...metadata, ...page(Array.isArray(commits) ? commits : [], input.offset, Math.min(input.limit, 30)), fileCount: Object.keys(fileMap).length, ...(path ? { path, lastCommit: fileMap[path] ?? null } : {}) };
    }
    if (typeof source.content === 'string') return { ...source, content: excerpt(source.content, input.offset, input.limit) };
    if (Array.isArray(source.entries)) return { ...source, ...page(source.entries, input.offset, Math.min(input.limit, 50)), entries: undefined };
    return { ...source, fileCount: Array.isArray(source.files) ? source.files.length : undefined, files: undefined };
  }));
}

import { z } from 'zod';
import { ENVIRONMENT_NAME } from '../deploy-environments';
import { SECRET_ACTIONS, SECRET_VALUE_MAX_BYTES } from '../../shared/secrets';
import type { McpServer } from '@modelcontextprotocol/server';
import { repositoryId, requestKey, readOnly, destructive } from '../mcp-schemas';
import { guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_secrets', {
    title: 'Read repository secret links', description: 'Read a repository’s Secrets Store links per environment (preview means Worker Previews): binding, store, secret, consumers, rotation and validation; the secrets each Wrangler config requires and which are missing; and the connection’s Secrets Store access. view catalog lists stores, or a store’s secret names (secret managers only). Values are never readable. Read-only.',
    inputSchema: z.object({ repository_id: repositoryId, view: z.enum(['status', 'catalog']).default('status'), store_id: z.string().regex(/^[a-f0-9]{32}$/).optional().describe('For catalog: list this store’s secrets.') }).strict(), annotations: readOnly,
  }, (input) => guarded(async () => {
    const path = `/api/repositories/${input.repository_id}/secrets`;
    return call<Record<string, unknown>>(input.view === 'catalog' ? `${path}/catalog${input.store_id ? `?store_id=${input.store_id}` : ''}` : path);
  }));
  server.registerTool('gitflare_manage_secret', {
    title: 'Link, create or rotate a repository secret', description: 'Change Secrets Store links: link an existing secret, create one from value, rotate its value, update consumers or preview_allowed, validate, unlink (the secret stays in Cloudflare) or create-store. value is write-only: sent to Cloudflare, never stored or returned. Deploys bind the environment’s links. Owner or a secret grant; needs admin access.',
    inputSchema: z.object({ repository_id: repositoryId, action: z.enum(SECRET_ACTIONS), environment: z.string().regex(ENVIRONMENT_NAME).optional().describe('production, staging, another Wrangler env, or preview. Required except for create-store.'), binding: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional().describe('Worker binding name, e.g. STRIPE_KEY. Required except for create-store.'), store_id: z.string().regex(/^[a-f0-9]{32}$/).optional().describe('For link and create: the Secrets Store ID.'), secret_id: z.string().regex(/^[a-f0-9]{32}$/).optional().describe('For link: the secret ID.'), secret_name: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).optional().describe('For link (instead of secret_id) and create: the secret name in the store.'), value: z.string().min(1).max(SECRET_VALUE_MAX_BYTES).optional().describe('For create and rotate only. Write-only; never echoed.'), comment: z.string().max(300).optional().describe('For create: a note stored on the secret in Cloudflare.'), preview_allowed: z.boolean().optional().describe('For link, create and update in the preview environment: allow Worker Previews to bind it.'), consumers: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/)).max(20).optional().describe('Worker names that receive the binding; empty means every Worker the environment deploys.'), name: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/).optional().describe('For create-store: the store name.'), idempotency_key: requestKey }).strict(), annotations: { ...destructive, openWorldHint: true, idempotentHint: false },
  }, (input) => guarded(async () => {
    const body = Object.fromEntries(Object.entries({ action: input.action, environment: input.environment, binding: input.binding, storeId: input.store_id, secretId: input.secret_id, secretName: input.secret_name, value: input.value, comment: input.comment, previewAllowed: input.preview_allowed, consumers: input.consumers, name: input.name }).filter(([, value]) => value !== undefined));
    return call<Record<string, unknown>>(`/api/repositories/${input.repository_id}/secrets`, body, input.idempotency_key);
  }));
}

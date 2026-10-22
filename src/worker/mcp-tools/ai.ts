import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { requestKey, readOnly, destructive, external } from '../mcp-schemas';
import { guarded } from '../mcp-results';
import type { McpToolContext } from './context';

export function register(server: McpServer, { call, origin }: McpToolContext): void {
  server.registerTool('gitflare_model_connections', {
    title: 'Inspect enabled model connections', description: 'List the models enabled in this workspace, the default model for new missions (defaultModel), the AI Gateway setup and the Workers AI catalog. A listed model is not proof that inference works. Provider keys are managed with gitflare_manage_ai_key or stored in AI Gateway. Read-only.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => guarded(async () => call<Record<string, unknown>>('/api/models')));
  server.registerTool('gitflare_manage_model_connection', {
    title: 'Configure or verify a model connection', description: 'Add or remove a workspace model, make one the default for new missions, or verify one with a small billed inference call through AI Gateway. Never accepts provider keys or URLs; verification is not repeated after an uncertain result. A workspace without platform AI access needs a matching key (gitflare_manage_ai_key) or its own AI Gateway. Needs the Owner role and admin access.',
    inputSchema: z.object({ action: z.enum(['add', 'remove', 'verify', 'default']), model: z.object({ id: z.string().min(1).max(200).describe('provider/model identifier, for example openai/gpt-6-luna.'), label: z.string().min(1).max(80), source: z.enum(['gateway', 'workers-ai']), protocol: z.enum(['responses', 'chat', 'anthropic', 'workers-ai']) }).strict().optional().describe('Required for add.'), model_id: z.string().min(1).max(200).optional().describe('Model to remove, verify or make the default.'), idempotency_key: requestKey }).strict(), annotations: { ...external, destructiveHint: true },
  }, input => guarded(async () => call<Record<string, unknown>>('/api/models/action', { action: input.action, ...(input.model ? { model: input.model } : {}), ...(input.model_id ? { modelId: input.model_id } : {}) }, input.idempotency_key)));
  const aiProvider = z.enum(['openai', 'anthropic', 'google-ai-studio', 'groq', 'mistral', 'deepseek', 'grok']);
  server.registerTool('gitflare_ai_keys', {
    title: 'Inspect workspace AI keys', description: 'Read which providers have a workspace AI key (provider, last four characters, who added it and when), the optional workspace AI Gateway, and whether this workspace can run AI missions. Key values are never returned. Read-only.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => guarded(async () => call<Record<string, unknown>>('/api/ai-keys')));
  server.registerTool('gitflare_manage_ai_key', {
    title: 'Add, test or remove a workspace AI key', description: 'Test a stored provider key with one small billed call through AI Gateway, or remove it. add returns a browser URL where the Owner pastes the key; keys are never sent through MCP, never returned and never reach sandboxes. Needs the Owner role and admin access.',
    inputSchema: z.object({ action: z.enum(['add', 'test', 'remove']), provider: aiProvider, model_id: z.string().min(1).max(200).optional().describe('Model used by test.'), idempotency_key: requestKey }).strict(), annotations: { ...destructive, openWorldHint: true },
  }, input => guarded(async () => {
    if (input.action === 'add') return { browserStartUrl: `${origin}/settings/models`, browserEntryRequired: true, provider: input.provider };
    return call<Record<string, unknown>>('/api/ai-keys/action', { action: input.action, provider: input.provider, ...(input.model_id ? { modelId: input.model_id } : {}) }, input.idempotency_key);
  }));
  server.registerTool('gitflare_manage_ai_gateway', {
    title: 'Use your own AI Gateway', description: 'Route this workspace\'s model calls through an AI Gateway in your own Cloudflare account (account ID and gateway ID), or clear it. set replaces the stored gateway, including any authentication value. authenticate returns a browser URL where the Owner enters the gateway authentication value; it is never sent through MCP. Needs the Owner role and admin access.',
    inputSchema: z.object({ action: z.enum(['set', 'clear', 'authenticate']), account_id: z.string().regex(/^[a-f0-9]{32}$/).optional().describe('Required for set.'), gateway_id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional().describe('Required for set.'), idempotency_key: requestKey }).strict(), annotations: { ...destructive, openWorldHint: true },
  }, input => guarded(async () => {
    if (input.action === 'authenticate') return { browserStartUrl: `${origin}/settings/models`, browserEntryRequired: true };
    return call<Record<string, unknown>>('/api/ai-gateway', input.action === 'clear' ? { action: 'clear' } : { action: 'set', accountId: input.account_id, gatewayId: input.gateway_id }, input.idempotency_key);
  }));
}

export function registerSettings(server: McpServer, { call }: McpToolContext): void {
  server.registerTool('gitflare_ai_settings', {
    title: 'Read AI feature settings', description: 'Read whether AI features are on for this workspace. Off blocks missions, drafting and model settings; Git, reviews and landing keep working. Read-only.',
    inputSchema: z.object({}).strict(), annotations: readOnly,
  }, () => guarded(async () => call<Record<string, unknown>>('/api/settings/ai')));
  server.registerTool('gitflare_set_ai_features', {
    title: 'Turn AI features on or off', description: 'Turn AI features on or off for this workspace. Off blocks missions, drafting and model settings; Git, reviews and landing keep working. Needs the Owner role and admin access.',
    inputSchema: z.object({ enabled: z.boolean(), idempotency_key: requestKey }).strict(), annotations: destructive,
  }, (input) => guarded(async () => call<Record<string, unknown>>('/api/settings/ai', { enabled: input.enabled }, input.idempotency_key)));
}

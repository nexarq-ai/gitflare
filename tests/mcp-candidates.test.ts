import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcp, type McpApi } from '../src/worker/mcp';
import type { Mission } from '../src/shared/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, WorkflowEntrypoint: class {} }));

const base = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const raceSha = 'c'.repeat(40);
const mission: Mission = { id: 'mission-1', repositoryId: 'repo-1', title: 'Chat', prompt: 'Build chat', status: 'needs_review', baseSha: base, candidateSha: candidate, epoch: 1, runs: [], checks: [], events: [], changes: [], createdAt: '2026-10-17T00:00:00Z', updatedAt: '2026-10-17T00:00:00Z' };
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

async function connect(api: McpApi) {
  const client = new Client({ name: 'gitflare-test-client', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL('https://gitflare.test/mcp'), {
    fetch: (input, init) => {
      const request = new Request(input, init);
      request.headers.set('Host', new URL(request.url).host);
      return handleMcp(request, api);
    },
  }));
  return client;
}

describe('MCP wording and candidate evidence', () => {
  it('names the dependency acknowledgement as approve_dependencies in approve and land errors', async () => {
    const client = await connect(async () => Response.json({ error: { code: 'DEPENDENCY_APPROVAL_REQUIRED', message: 'This candidate changes package.json dependencies (zod added). Approve again with approveDependencies set to true to accept them.' } }, { status: 409 }));
    const args = { mission_id: mission.id, candidate_sha: candidate, base_sha: base, idempotency_key: 'owner-deps-request-0002' };
    for (const name of ['gitflare_approve_mission', 'gitflare_integrate_mission']) {
      const text = JSON.stringify((await client.callTool({ name, arguments: args })).content);
      expect(text, name).toContain('approve_dependencies set to true');
      expect(text, name).not.toContain('approveDependencies');
    }
  });

  it('reports a fork-held candidate as such and points every changed file at the commit to read it from', async () => {
    const race: Mission = { ...mission, mode: 'race', candidateSha: null, runs: [{ id: 'run-b', name: 'B', role: 'Attempt', task: 'Do it', status: 'completed', commitSha: raceSha, forkName: 'fork-b', changedFiles: ['wrangler.jsonc'] }], raceChanges: [{ path: 'wrangler.jsonc', additions: 1, deletions: 0, patch: '+{}', runIds: ['run-b'] }] };
    const combined: Mission = { ...mission, changes: [{ path: 'src/index.ts', additions: 1, deletions: 0, patch: '+x', runIds: ['run-a'] }] };
    let current = race;
    const client = await connect(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/missions/mission-1') return Response.json(current);
      if (url.pathname.endsWith('/file')) return Response.json({ path: 'wrangler.jsonc', content: '{}', commitSha: raceSha, missionId: mission.id, source: 'mission-candidate' });
      if (url.pathname.endsWith('/tree')) return Response.json({ ref: raceSha, commitSha: raceSha, missionId: mission.id, source: 'mission-candidate', entries: [{ name: 'wrangler.jsonc', path: 'wrangler.jsonc', type: 'file' }] });
      return Response.json({ error: { code: 'NOT_FOUND', message: 'Unknown test API route' } }, { status: 404 });
    });
    const file = await client.callTool({ name: 'gitflare_read_file', arguments: { repository_id: 'repo-1', ref: raceSha, path: 'wrangler.jsonc' } });
    expect(file.structuredContent).toMatchObject({ commitSha: raceSha, missionId: mission.id, source: 'mission-candidate', text: '{}' });
    const tree = await client.callTool({ name: 'gitflare_browse_repository', arguments: { repository_id: 'repo-1', ref: raceSha } });
    expect(tree.structuredContent).toMatchObject({ commitSha: raceSha, missionId: mission.id, source: 'mission-candidate', total: 1 });
    const changes = await client.callTool({ name: 'gitflare_inspect_mission', arguments: { mission_id: mission.id, view: 'changes' } });
    expect(changes.structuredContent).toMatchObject({ items: [{ path: 'wrangler.jsonc', readFile: { tool: 'gitflare_read_file', ref: raceSha, path: 'wrangler.jsonc' } }], patchGuidance: expect.stringContaining('call gitflare_read_file with the change') });
    current = combined;
    const merged = await client.callTool({ name: 'gitflare_inspect_mission', arguments: { mission_id: mission.id, view: 'changes' } });
    expect(merged.structuredContent).toMatchObject({ items: [{ path: 'src/index.ts', readFile: { ref: candidate, path: 'src/index.ts' } }] });
  });
});

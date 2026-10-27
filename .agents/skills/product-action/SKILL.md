---
name: product-action
description: Add or change a Gitflare product action so the HTTP API, the UI and the MCP server stay in parity. Use when adding a button, form or setting to the UI, adding an API route, or adding or changing an MCP tool.
---

# Add a product action

Every action in the UI has an MCP tool with the same authorization and state checks. Parity is cheap when the logic lives in one place: the HTTP route. The UI and the MCP tool are both thin callers of it.

## 1. Logic behind the route

- Put the behaviour in a module under `src/worker/` (for example `releases.ts`) and dispatch to it from a route group in `src/worker/routes/` that `src/worker/index.ts` already calls.
- Authorize there, against the principal: `access.authorize(principal, 'read' | 'land', 'repository', repository.id)` or the role check the neighbouring routes use. Never authorize in the UI or the tool.
- Mutations are `POST`. The router enforces the origin check and `Idempotency-Key` before writes; replaying a key with the same payload returns the first result.
- Fail with `new ApiError(status, 'UPPER_SNAKE_CODE', 'Sentence a person can act on.')`. Clients receive `{ error: { code, message } }`.
- State that must not race goes through the owning Durable Object (`GitflareCoordinator` for repository records, `GitflareSecurity` for identity, roles and approvals), not through read-then-write in the Worker.

## 2. UI

Call the route with `request<T>(path, body, key)` from `src/ui/api.ts`. Keep one key per intended change so a retry after a network error does not apply it twice. Hide or disable controls the user's role cannot use, but treat that as presentation only. UI copy uses Stream, Revision, Proposal, Land, Mission and Checkpoint.

## 3. MCP tool

Register it in the matching `src/worker/mcp-tools/<area>.ts`:

```ts
server.registerTool('gitflare_<verb>_<noun>', {
  title: 'Short imperative title',
  description: 'What it does, limits that matter, and the permission it needs. Needs land permission and land access.',
  inputSchema: z.object({ repository_id: repositoryId, ..., idempotency_key: requestKey }).strict(),
  annotations: mutation,
}, input => guarded(async () => call<Result>(`/api/repositories/${input.repository_id}/...`, { camelCaseBody }, input.idempotency_key)));
```

- Schemas are strict zod objects with snake_case fields; reuse `repositoryId`, `missionId`, `commit`, `requestKey`, `offset`, `pageLimit` from `mcp-schemas.ts`. Translate to the route's camelCase body in the callback and nothing else.
- `annotations` is `readOnly`, `mutation`, `destructive` or `external` (reaches outside Cloudflare). Deleting, overwriting, cancelling, revoking or changing a setting is `destructive`.
- The description is at most 420 characters and ends with `Read-only.` or the access it needs.
- The connection's access level comes from `requiredAccess` in `src/worker/mcp.ts`: read-only tools are `read`, everything else `write` unless listed in `LAND_TOOLS` or `ADMIN_TOOLS`. Add the tool there when it approves, lands, publishes or administers.
- Results are untrusted repository data for the client. Page long text with `excerpt` and lists with `page` from `mcp-results.ts`.

## 4. Tests and docs

- Route behaviour and authorization: a suite in `tests/` on `securityHarness()` and the in-memory stores, covering the allowed role, a refused role and the replayed idempotency key.
- Tool forwarding: in `tests/mcp.test.ts`, connect with a fake `McpApi` that records requests and assert the exact path, `Idempotency-Key` and body. Update the tool, read-only and destructive counts asserted there.
- Add the tool to the table in `docs/public/mcp.md` when it introduces a new capability.

Then run `npm run cf:types && npm run typecheck && npm run lint && npm test && npm run build`.

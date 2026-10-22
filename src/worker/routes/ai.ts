import { ApiError, assertMutationOrigin, readJson, requireIdempotencyKey } from '../domain';
import { modelConnectionsSnapshot, modelIdentifier, resolveModelConnection, validateModelConnection, verifyModelConnection } from '../model-config';
import { aiKeyProvider, aiKeysSnapshot, assertModelAccess, createModelAccess, encryptAiGateway, encryptAiKey, ownGatewayInput, providerKey, storedOwnGateway, storedProviderKey, verificationModel, verifyProviderKey } from '../ai-keys';
import { type RouteContext, aiSettings, requireAi } from '../route-context';
import { security } from '../request-auth';

const HOUR_MS = 3_600_000;
const AI_KEY_WRITE_LIMIT = { max: 20, windowMs: HOUR_MS };

export async function aiRoutes(context: RouteContext): Promise<Response | null> {
  const { request, url, env, principal, access, catalog } = context;
  if (request.method === 'GET' && url.pathname === '/api/models') {
    await access.authorizeMetadata(principal);
    const [models, defaultModel] = await Promise.all([catalog.getModelConnections(), catalog.getDefaultModel()]);
    return Response.json(modelConnectionsSnapshot(env, models, defaultModel));
  }
  if (url.pathname === '/api/settings/ai') {
    if (request.method === 'GET') { await access.authorizeMetadata(principal); return Response.json(await aiSettings(env, catalog)); }
    if (request.method === 'POST') {
      assertMutationOrigin(request);
      await access.authorize(principal, 'manage');
      requireIdempotencyKey(request);
      const body = await readJson(request);
      if (typeof body.enabled !== 'boolean') throw new ApiError(400, 'INVALID_INPUT', 'Send enabled as true or false.');
      if (body.enabled && env.AI_FEATURES === 'disabled') throw new ApiError(409, 'AI_LOCKED', 'AI features are turned off for this installation with AI_FEATURES=disabled.');
      await catalog.setAiEnabled(body.enabled);
      return Response.json(await aiSettings(env, catalog));
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/models/action') {
    assertMutationOrigin(request);
    await access.authorize(principal, 'manage');
    const key = requireIdempotencyKey(request), body = await readJson(request);
    if (body.action === 'default') return Response.json(modelConnectionsSnapshot(env, await catalog.setDefaultModel(modelIdentifier(body.modelId)), await catalog.getDefaultModel()));
    if (body.action !== 'remove') await requireAi(env, catalog);
    if (!['add', 'remove', 'verify'].includes(String(body.action))) throw new ApiError(400, 'INVALID_MODEL_ACTION', 'Choose add, remove, verify or default.');
    const model = body.action === 'add' ? validateModelConnection(body.model) : undefined;
    const modelId = model?.id ?? modelIdentifier(body.modelId);
    const fingerprint = JSON.stringify(['model', body.action, model ?? modelId]);
    const receipt = await catalog.getModelRequest(key, fingerprint);
    if (receipt?.result) return Response.json(modelConnectionsSnapshot(env, receipt.result, await catalog.getDefaultModel()));
    if (receipt) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'This model verification is running or interrupted. An unconfirmed billed call will not be repeated.');
    if (body.action === 'verify') {
      const configured = resolveModelConnection(await catalog.getModelConnections(), modelId);
      if (!await catalog.claimModelVerification(key, fingerprint)) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'Model verification is already in progress.');
      await access.check(principal, 'manage');
      const credentials = await catalog.getAiCredentials();
      assertModelAccess(env, principal.workspaceId, credentials, [configured]);
      const verified = await verifyModelConnection({ ...env, modelAccess: createModelAccess(env, principal.workspaceId, { getAiCredentials: () => catalog.getAiCredentials() }) }, configured);
      return Response.json(modelConnectionsSnapshot(env, await catalog.completeModelVerification(key, fingerprint, verified), await catalog.getDefaultModel()));
    }
    return Response.json(modelConnectionsSnapshot(env, await catalog.changeModelConnections(key, fingerprint, body.action as 'add' | 'remove', model ?? modelId), await catalog.getDefaultModel()));
  }
  if (request.method === 'GET' && url.pathname === '/api/ai-keys') {
    await access.authorizeMetadata(principal);
    return Response.json(aiKeysSnapshot(env, principal.workspaceId, await catalog.getAiCredentials()));
  }
  if (request.method === 'POST' && url.pathname === '/api/ai-keys/action') {
    assertMutationOrigin(request);
    await access.authorize(principal, 'manage');
    requireIdempotencyKey(request);
    const body = await readJson(request);
    if (!['add', 'remove', 'test'].includes(String(body.action))) throw new ApiError(400, 'INVALID_AI_KEY_ACTION', 'Choose add, remove or test.');
    const provider = aiKeyProvider(body.provider);
    if (body.action === 'remove') return Response.json(aiKeysSnapshot(env, principal.workspaceId, await catalog.removeAiKey(provider)));
    await requireAi(env, catalog);
    await security(env).rateLimit(`ai-key:${principal.workspaceId}`, AI_KEY_WRITE_LIMIT.max, AI_KEY_WRITE_LIMIT.windowMs);
    const credentials = await catalog.getAiCredentials();
    const key = body.action === 'add' ? providerKey(body.key) : await storedProviderKey(env, principal.workspaceId, credentials, provider);
    const model = verificationModel(provider, await catalog.getModelConnections(), typeof body.modelId === 'string' ? body.modelId : undefined);
    const result = await verifyProviderKey(env, principal.workspaceId, provider, key, model, await storedOwnGateway(env, principal.workspaceId, credentials));
    if (!result.ok) throw new ApiError(400, 'AI_KEY_INVALID', `The ${model.id} check failed. ${result.detail}`);
    await access.check(principal, 'manage');
    const saved = body.action === 'add' ? await catalog.saveAiKey(await encryptAiKey(env, principal.workspaceId, provider, key, principal.userId, model.id)) : credentials;
    return Response.json({ ...aiKeysSnapshot(env, principal.workspaceId, saved), verification: { provider, model: model.id, detail: result.detail } });
  }
  if (request.method === 'POST' && url.pathname === '/api/ai-gateway') {
    assertMutationOrigin(request);
    await access.authorize(principal, 'manage');
    requireIdempotencyKey(request);
    const body = await readJson(request);
    if (body.action === 'clear') return Response.json(aiKeysSnapshot(env, principal.workspaceId, await catalog.saveAiGateway(null)));
    if (body.action !== 'set') throw new ApiError(400, 'INVALID_AI_GATEWAY_ACTION', 'Choose set or clear.');
    await requireAi(env, catalog);
    const record = await encryptAiGateway(env, principal.workspaceId, ownGatewayInput(body), principal.userId);
    return Response.json(aiKeysSnapshot(env, principal.workspaceId, await catalog.saveAiGateway(record)));
  }
  return null;
}

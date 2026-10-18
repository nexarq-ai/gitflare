export interface AiGatewayUniversalRequest {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
}

export interface ModelTransportAi {
  run(model: string, input: Record<string, unknown>, options?: { gateway: { id: string; metadata?: Record<string, string> }; extraHeaders?: Record<string, string>; signal?: AbortSignal }): Promise<unknown>;
  gateway?(id: string): { run(request: AiGatewayUniversalRequest | AiGatewayUniversalRequest[], options?: { extraHeaders?: object; signal?: AbortSignal }): Promise<Response> };
}

interface CallTiming { timeoutMs: number; stream?: boolean }
export type ModelCall =
  | CallTiming & { kind: 'fetch'; url: string; headers: Record<string, string>; body: string }
  | CallTiming & { kind: 'gateway'; gatewayId: string; request: AiGatewayUniversalRequest; extraHeaders?: Record<string, string> }
  | CallTiming & { kind: 'run'; gatewayId: string; model: string; input: Record<string, unknown>; metadata?: Record<string, string>; extraHeaders?: Record<string, string> };

export interface CallError { name: string; message: string; status?: number; code?: number }
export type ModelCallOutcome =
  | { kind: 'response'; status: number; logId?: string; body: string; colo?: string }
  | { kind: 'value'; value: unknown }
  | { kind: 'stream'; status: number; logId?: string; body: ReadableStream<Uint8Array> }
  | { kind: 'error'; error: CallError; colo?: string };
export type RelayedOutcome = ModelCallOutcome & { regions: string[]; locationRefused: boolean };

export const RELAY_REGIONS = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'apac-ne', 'apac-se', 'oc', 'afr', 'me'] as const;
export type RelayRegion = typeof RELAY_REGIONS[number];
export const DEFAULT_RELAY_REGION: RelayRegion = 'enam';
export const RELAY_SHARDS = 8;

export interface ModelRelayStub { call(call: ModelCall): Promise<ModelCallOutcome> }
export interface ModelRelayNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId, options?: { locationHint?: RelayRegion }): ModelRelayStub;
}
export interface ModelTransportEnv {
  AI?: ModelTransportAi;
  MODEL_RELAY?: ModelRelayNamespace;
  MODEL_RELAY_LOCATION_HINT?: string;
}

export function relayRegions(configured: string | undefined): [RelayRegion, RelayRegion] {
  const primary = RELAY_REGIONS.find(region => region === configured?.trim().toLowerCase()) ?? DEFAULT_RELAY_REGION;
  return [primary, primary === 'enam' ? 'wnam' : 'enam'];
}

const LOCATION_REFUSAL = /request not allowed|unsupported_country|country, region,? or territory not supported|not available in your (?:country|region|location)|unsupported (?:country|region|location)/i;

export function isLocationRefusal(outcome: ModelCallOutcome): boolean {
  if (outcome.kind === 'response') return outcome.status === 403 && LOCATION_REFUSAL.test(outcome.body);
  if (outcome.kind === 'error') return (outcome.error.status === 403 || /\b403\b/.test(outcome.error.message)) && LOCATION_REFUSAL.test(outcome.error.message);
  return false;
}

export async function cloudflareLocation(): Promise<string | undefined> {
  try {
    const trace = await (await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(2000) })).text();
    return /^colo=([A-Z]{3})$/m.exec(trace)?.[1];
  } catch { return undefined; }
}

function callError(error: unknown): CallError {
  const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = raw.status ?? raw.statusCode;
  return {
    name: typeof raw.name === 'string' ? raw.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof raw.code === 'number' ? { code: raw.code } : {}),
  };
}

// The caller enforces stream deadlines and must time out before this signal does
export const STREAM_ABORT_GRACE_MS = 5_000;

export async function performModelCall(env: Pick<ModelTransportEnv, 'AI'>, call: ModelCall, locate: () => Promise<string | undefined> = cloudflareLocation): Promise<ModelCallOutcome> {
  const signal = AbortSignal.timeout(call.timeoutMs + (call.stream ? STREAM_ABORT_GRACE_MS : 0));
  try {
    if (call.kind === 'run') {
      if (!env.AI) throw new Error('AI Gateway connection is not configured');
      const value = await env.AI.run(call.model, call.input, { gateway: { id: call.gatewayId, ...(call.metadata ? { metadata: call.metadata } : {}) }, ...(call.extraHeaders ? { extraHeaders: call.extraHeaders } : {}), signal });
      if (call.stream && value instanceof ReadableStream) return { kind: 'stream', status: 200, body: value };
      if (!(value instanceof Response)) return { kind: 'value', value };
      return await responseOutcome(value, call, locate);
    }
    let response: Response;
    if (call.kind === 'fetch') response = await fetch(call.url, { method: 'POST', headers: call.headers, body: call.body, signal });
    else {
      if (!env.AI?.gateway) throw new Error('AI Gateway connection is not configured');
      response = await env.AI.gateway(call.gatewayId).run(call.request, { ...(call.extraHeaders ? { extraHeaders: call.extraHeaders } : {}), signal });
    }
    return await responseOutcome(response, call, locate);
  } catch (error) {
    const failure = callError(error);
    const colo = failure.status === 403 || /\b403\b/.test(failure.message) ? await locate() : undefined;
    return { kind: 'error', error: failure, ...(colo ? { colo } : {}) };
  }
}

async function responseOutcome(response: Response, call: ModelCall, locate: () => Promise<string | undefined>): Promise<ModelCallOutcome> {
  const logId = response.headers.get('cf-aig-log-id') ?? undefined;
  if (call.stream && response.ok && response.body) return { kind: 'stream', status: response.status, body: response.body, ...(logId ? { logId } : {}) };
  let body = '';
  try { body = await response.text(); }
  catch { body = ''; }
  const colo = response.status === 403 ? await locate() : undefined;
  return { kind: 'response', status: response.status, body, ...(logId ? { logId } : {}), ...(colo ? { colo } : {}) };
}

export class StreamTimeoutError extends Error {
  constructor(public readonly idle: boolean, public readonly afterMs: number) {
    super(idle ? `The model stream sent nothing for ${Math.round(afterMs / 1000)}s` : 'The operation was aborted due to timeout');
    this.name = 'TimeoutError';
  }
}

export const MAX_STREAM_BYTES = 8 * 1024 * 1024;

export async function* streamText(body: ReadableStream<Uint8Array>, idleMs: number, totalMs: number): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + totalMs;
  let bytes = 0;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new StreamTimeoutError(false, totalMs);
      const idle = idleMs <= remaining;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StreamTimeoutError(idle, idle ? idleMs : totalMs)), Math.min(idleMs, remaining)); });
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await Promise.race([reader.read(), expired]); }
      finally { clearTimeout(timer); }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw new Error(`The model stream exceeded ${MAX_STREAM_BYTES / 1024 / 1024} MiB`);
      const text = decoder.decode(chunk.value, { stream: true });
      if (text) yield text;
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    reader.cancel().catch(() => {});
  }
}

export function outcomeResponse(outcome: Extract<ModelCallOutcome, { kind: 'response' }>): Response {
  return new Response(outcome.status === 204 || outcome.status === 304 ? null : outcome.body, { status: outcome.status, headers: outcome.logId ? { 'cf-aig-log-id': outcome.logId } : {} });
}

export function outcomeError(error: CallError): Error {
  return Object.assign(new Error(error.message), { name: error.name, ...(error.status !== undefined ? { status: error.status } : {}), ...(error.code !== undefined ? { code: error.code } : {}) });
}

async function viaRelay(relay: ModelRelayNamespace, region: RelayRegion, call: ModelCall): Promise<ModelCallOutcome> {
  const shard = Math.floor(Math.random() * RELAY_SHARDS);
  return relay.get(relay.idFromName(`relay-${region}-${shard}`), { locationHint: region }).call(call);
}

export async function sendModelCall(env: ModelTransportEnv, call: ModelCall): Promise<RelayedOutcome> {
  if (!env.MODEL_RELAY) {
    const outcome = await performModelCall(env, call);
    return { ...outcome, regions: [], locationRefused: isLocationRefusal(outcome) };
  }
  const [primary, alternate] = relayRegions(env.MODEL_RELAY_LOCATION_HINT);
  const first = await viaRelay(env.MODEL_RELAY, primary, call);
  if (!isLocationRefusal(first)) return { ...first, regions: [primary], locationRefused: false };
  console.warn(JSON.stringify({ event: 'model_location_refused', region: primary, colo: 'colo' in first ? first.colo ?? null : null, retryRegion: alternate }));
  const second = await viaRelay(env.MODEL_RELAY, alternate, call);
  return { ...second, regions: [primary, alternate], locationRefused: isLocationRefusal(second) };
}

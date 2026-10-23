import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import type { ArtifactsBinding } from '../src/worker/artifacts';
import { wranglerInstallCommand } from '../src/worker/worker-bundle';
import { COREPACK_ENV, INSTALL_EXCLUDES, INSTALL_TIMEOUT_MS, installCommand, NPM_REGISTRY, registryHosts, YARN_REGISTRY, type InstallMode, type InstallPlan } from '../src/worker/package-manager';
import { MAX_TEST_TIMEOUT_MS } from '../src/worker/budgets';
import { DEFAULT_RUNNER, isRunnerSize, type RunnerSize } from '../src/worker/repository-policy';
import { detectListeningPort, PREVIEW_PORT } from '../src/worker/preview-plan';
import { beginUrlImportJob, importJobDependencies, proxyImportSource, resumeUrlImportJob, type ImportSourceProps, type UrlImportEnv, type UrlImportJob } from '../src/worker/url-import';

export interface GitPermission { name: string; remote: string; write: boolean }
export interface CommandResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }
export interface PrepareOptions { runner?: RunnerSize }
interface RunnerEnv extends Omit<UrlImportEnv, 'ARTIFACTS'> { ARTIFACTS: ArtifactsBinding; RUNNER_IMAGE?: string }
interface OutboundProps { repositories: GitPermission[] }
interface RegistryProps { hosts?: string[] }

const ca = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
// Vite-based dev and preview servers reject any Host other than localhost
const previewHost = (port: number) => `http://localhost:${port}`;
const LOCAL_PREVIEW_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/.*)?$/i;
const PREVIEW_LOG = '/tmp/gitflare-preview.log';
const PREVIEW_PID = '/tmp/gitflare-preview.pid';
export const STOP_PREVIEW_SCRIPT = `pid=$(cat ${PREVIEW_PID} 2>/dev/null) || exit 0; rm -f ${PREVIEW_PID}; kill -TERM -- -"$pid" 2>/dev/null || exit 0; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -"$pid" 2>/dev/null || exit 0; sleep 0.5; done; kill -KILL -- -"$pid" 2>/dev/null; exit 0`;
const PREVIEW_LOG_LINES = 40;
const LOG_POLL_MS = 2_000;
const LOG_READ_MS = 5_000;
export const SANDBOX_MAX_LIFETIME_MS = 7_200_000;
export const COMMAND_OUTPUT_CAP = 65_536;
export const BUNDLE_OUTPUT_CAP = 16 * 1024 * 1024;
const DEADLINE_GRACE_MS = 10_000;
const TIMEOUT_EXIT_CODES = [124, 137, 143];

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return merged;
}

export async function readCappedOutput(stream: ReadableStream<Uint8Array> | null, cap: number, strict = false, observe?: (chunk: Uint8Array) => void): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const headCap = strict ? cap : Math.floor(cap / 4);
  const tailCap = cap - headCap;
  const head: Uint8Array[] = [];
  let tail: Uint8Array[] = [];
  let headBytes = 0, tailBytes = 0, bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    observe?.(next.value);
    if (strict && bytes > cap) {
      await reader.cancel();
      throw new Error(`Command output exceeded ${cap} bytes`);
    }
    let value = next.value.slice();
    if (headBytes < headCap) {
      const taken = value.subarray(0, headCap - headBytes);
      head.push(taken);
      headBytes += taken.byteLength;
      value = value.subarray(taken.byteLength);
    }
    if (!value.byteLength) continue;
    tail.push(value);
    tailBytes += value.byteLength;
    while (tail.length > 1 && tailBytes - tail[0]!.byteLength >= tailCap) tailBytes -= tail.shift()!.byteLength;
  }
  const decoder = new TextDecoder();
  if (bytes <= cap) return decoder.decode(joinChunks([...head, ...tail]));
  const kept = joinChunks(tail);
  return `${decoder.decode(joinChunks(head))}\n[output truncated] ${bytes - cap} bytes omitted; the last ${tailCap} bytes follow\n${decoder.decode(kept.subarray(kept.byteLength - tailCap))}`;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/(\w+:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/g, '$1[redacted]@'],
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [redacted]'],
  [/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]'],
  [/\b(?:sk|ghp|gho|github_pat|xox[abp]|AKIA)[\w-]{12,}/g, '[redacted]'],
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export function commandSummary(argv: string[], limit = 240): string {
  const script = argv[0] && /(?:^|\/)(?:ba)?sh$/.test(argv[0]) && /^-l?c$/.test(argv[1] ?? '') ? argv[2] : undefined;
  const joined = script ?? argv.map((part) => /^[\w@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part)).join(' ');
  const text = redactSecrets(joined.replace(/\s+/g, ' ').trim());
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

const TAIL_BYTES = 16_384;

export class OutputTail {
  #chunks: Uint8Array[] = [];
  #bytes = 0;

  add(chunk: Uint8Array): void {
    this.#chunks.push(chunk.slice());
    this.#bytes += chunk.byteLength;
    while (this.#chunks.length > 1 && this.#bytes - this.#chunks[0]!.byteLength >= TAIL_BYTES) this.#bytes -= this.#chunks.shift()!.byteLength;
  }

  lines(count: number): string[] {
    const text = new TextDecoder().decode(joinChunks(this.#chunks)).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    return text ? text.split('\n').slice(-count).map((line) => redactSecrets(line).slice(0, 500)) : [];
  }
}

export function previewLogTail(log: string, count = PREVIEW_LOG_LINES): string[] {
  const text = log.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return text ? text.split('\n').slice(-count).map((line) => redactSecrets(line).slice(0, 500)) : [];
}

export function previewFailureMessage(reason: string, log: string): string {
  const lines = previewLogTail(log);
  return `${reason}${lines.length ? `\nLast ${lines.length} line${lines.length === 1 ? '' : 's'} of dev server output:\n${lines.join('\n')}` : '\nThe dev server produced no output.'}`;
}

export function deadlineMessage(argv: string[], deadlineMs: number, elapsedMs: number, tail: OutputTail): string {
  const lines = tail.lines(20);
  const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;
  return `Sandbox command exceeded its execution deadline: \`${commandSummary(argv)}\` ran ${seconds(elapsedMs)} against a ${seconds(deadlineMs)} deadline (plus ${seconds(DEADLINE_GRACE_MS)} grace) and the runner was stopped.${lines.length ? `\nLast ${lines.length} line${lines.length === 1 ? '' : 's'} of output:\n${lines.join('\n')}` : '\nThe command produced no output.'}`;
}

export class GitOutbound extends WorkerEntrypoint<RunnerEnv, OutboundProps> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const permission = this.ctx.props.repositories.find((repository) => {
      const remote = new URL(repository.remote);
      return url.protocol === 'https:' && url.origin === remote.origin && url.pathname.startsWith(`${remote.pathname}/`);
    });
    if (!permission) return new Response('Network destination is not allowed', { status: 403 });
    const suffix = url.pathname.slice(new URL(permission.remote).pathname.length);
    const service = url.searchParams.get('service');
    const isRead = (suffix === '/info/refs' && service === 'git-upload-pack') || suffix === '/git-upload-pack';
    const isWrite = (suffix === '/info/refs' && service === 'git-receive-pack') || suffix === '/git-receive-pack';
    if ((!isRead && !isWrite) || (isWrite && !permission.write)) return new Response('Git operation is not allowed', { status: 403 });
    using repository = await this.env.ARTIFACTS.get(permission.name);
    const token = await repository.createToken(isWrite ? 'write' : 'read', 60);
    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.set('authorization', `Bearer ${token.plaintext}`);
    return fetch(new Request(request, { headers, redirect: 'manual' }));
  }
}

export class ImportOutbound extends WorkerEntrypoint<RunnerEnv, ImportSourceProps> {
  async fetch(request: Request): Promise<Response> {
    return proxyImportSource(request, this.ctx.props);
  }
}

export class BootstrapOutbound extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const allowed = request.method === 'GET' && (
      (url.hostname === 'deb.debian.org' && /^\/debian\/(dists\/trixie(?:-updates)?\/|pool\/)/.test(url.pathname)) ||
      (['deb.debian.org', 'security.debian.org'].includes(url.hostname) && /^\/debian-security\/(dists\/trixie-security\/|pool\/)/.test(url.pathname))
    );
    if (!allowed) return new Response('Bootstrap destination is not allowed', { status: 403 });
    url.protocol = 'https:';
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return new Response('Bootstrap upstream redirects are not allowed', { status: 502 });
      }
      console.info('runner.bootstrap.fetch', url.hostname, url.pathname, response.status);
      return response;
    } catch (error) {
      console.error('runner.bootstrap.fetch.failed', url.hostname, url.pathname, error instanceof Error ? error.message : 'Unknown fetch error');
      return new Response('Bootstrap upstream fetch failed', { status: 502 });
    }
  }
}

const PACKAGE_REGISTRIES = [NPM_REGISTRY, YARN_REGISTRY];

export function isRegistryRequest(request: Request, hosts: string[] = [NPM_REGISTRY]): boolean {
  const url = new URL(request.url);
  return (request.method === 'GET' || request.method === 'HEAD') && url.protocol === 'https:' && hosts.includes(url.hostname) && PACKAGE_REGISTRIES.includes(url.hostname) && !url.port && !url.username && !url.password;
}

export class RegistryOutbound extends WorkerEntrypoint<RunnerEnv, RegistryProps> {
  async fetch(request: Request): Promise<Response> {
    if (!isRegistryRequest(request, this.ctx.props?.hosts)) return new Response('Install destination is not allowed', { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    const response = await fetch(new Request(request, { headers, redirect: 'manual' }));
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return new Response('Install upstream redirects are not allowed', { status: 502 });
    }
    return response;
  }
}

export class AgentSandbox extends DurableObject<RunnerEnv> {
  #repositories: GitPermission[] | undefined;
  readonly #importCredentials = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: RunnerEnv) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(600_000));
  }

  async prepare(repositories: GitPermission[], options: PrepareOptions = {}): Promise<void> {
    const container = this.ctx.container;
    if (!container) throw new Error('Container binding is not configured');
    const instance = options.runner ?? DEFAULT_RUNNER;
    if (!isRunnerSize(instance)) throw new Error(`Unsupported runner size ${String(instance)}`);
    if (container.running) await container.destroy();
    await this.ctx.storage.setAlarm(Date.now() + SANDBOX_MAX_LIFETIME_MS);
    const image = container.images?.tools ?? this.env.RUNNER_IMAGE ?? 'cloudflare/debian-trixie';
    container.start({ image, instance, entrypoint: ['sleep', 'infinity'], enableInternet: false });
    let stage = 'container startup';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = container.monitor().then(() => { throw new Error('Container stopped before runner preparation completed'); });
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Runner preparation exceeded its execution deadline')), image === 'cloudflare/debian-trixie' ? 600_000 : 120_000);
    });
    try {
      await Promise.race([(async () => {
        await container.setInactivityTimeout(600_000);
        if (image === 'cloudflare/debian-trixie') {
          stage = 'package bootstrap';
          const bootstrap = this.ctx.exports.BootstrapOutbound;
          await container.interceptAllOutboundHttp(bootstrap);
          await container.interceptOutboundHttps('*', bootstrap);
          const aptOptions = '-o Dir::Etc::sourcelist=/tmp/gitflare-sources.list -o Dir::Etc::sourceparts=- -o Acquire::Retries=0 -o Acquire::https::Timeout=15 -o Acquire::https::CaInfo=/etc/cloudflare/certs/cloudflare-containers-ca.crt';
          await this.#bootstrapCommand('package index', `printf '%s\n' 'deb https://deb.debian.org/debian trixie main' 'deb https://deb.debian.org/debian trixie-updates main' 'deb https://deb.debian.org/debian-security trixie-security main' > /tmp/gitflare-sources.list; apt-get ${aptOptions} -o APT::Update::Error-Mode=any update`);
          await this.#bootstrapCommand('package installation', `DEBIAN_FRONTEND=noninteractive apt-get ${aptOptions} install -y --no-install-recommends git ca-certificates ripgrep coreutils && mkdir -p /workspace`, 300_000);
        }
        stage = 'Git network isolation';
        await this.#restrictToGit(repositories);
        this.#repositories = repositories;
        stage = 'tool and certificate readiness';
        const readiness = await this.#executeCommand(['/bin/sh', '-c', 'mkdir -p /workspace && command -v node && command -v git && command -v bash && command -v timeout && test -r /etc/cloudflare/certs/cloudflare-containers-ca.crt'], '/', 15_000, 15_000);
        if (readiness.exitCode !== 0) throw new Error(`Runner tools or interception certificate are unavailable (exit ${readiness.exitCode})`);
      })(), stopped, deadline]);
    } catch (error) {
      try { await container.destroy(); } catch { console.error('runner.preparation.cleanup.failed'); }
      const exitCode = error && typeof error === 'object' && 'exitCode' in error ? ` (exit ${error.exitCode})` : '';
      throw new Error(`Runner preparation failed during ${stage}${exitCode}: ${error instanceof Error ? error.message : 'Unknown container error'}`);
    } finally { clearTimeout(timer); }
  }

  async #restrictToGit(repositories: GitPermission[]): Promise<void> {
    const container = this.ctx.container!;
    const outbound = this.ctx.exports.GitOutbound({ props: { repositories } });
    await container.interceptAllOutboundHttp(outbound);
    await container.interceptOutboundHttps('*', outbound);
  }

  async install(plan: InstallPlan, mode: InstallMode = 'install'): Promise<CommandResult> {
    const container = this.ctx.container;
    const repositories = this.#repositories;
    if (!container?.running || !repositories) throw new Error('Sandbox is not prepared');
    const argv = installCommand(plan, mode);
    const excluded = await this.#executeCommand(['/bin/sh', '-c', 'printf \'\\n%s\\n\' "$@" >> .git/info/exclude', 'exclude', ...INSTALL_EXCLUDES], '/workspace/repo', 15_000, 15_000);
    if (excluded.exitCode !== 0) throw new Error('Installed dependencies could not be excluded from candidate commits');
    const registry = this.ctx.exports.RegistryOutbound({ props: { hosts: registryHosts(plan) } });
    await container.interceptAllOutboundHttp(registry);
    await container.interceptOutboundHttps('*', registry);
    try {
      // --ignore-scripts / --mode=skip-build / --mode=update-lockfile: package lifecycle scripts must not run while the registry is reachable
      return await this.#executeCommand(argv, '/workspace/repo', INSTALL_TIMEOUT_MS, INSTALL_TIMEOUT_MS, COMMAND_OUTPUT_CAP, false, { COREPACK_ENABLE_NETWORK: '1' });
    } finally { await this.#restrictToGit(repositories); }
  }

  async installWrangler(version: string): Promise<CommandResult> {
    const container = this.ctx.container;
    const repositories = this.#repositories;
    if (!container?.running || !repositories) throw new Error('Sandbox is not prepared');
    const argv = wranglerInstallCommand(version);
    const registry = this.ctx.exports.RegistryOutbound({ props: { hosts: [NPM_REGISTRY] } });
    await container.interceptAllOutboundHttp(registry);
    await container.interceptOutboundHttps('*', registry);
    try { return await this.#executeCommand(argv, '/workspace', INSTALL_TIMEOUT_MS, INSTALL_TIMEOUT_MS); }
    finally { await this.#restrictToGit(repositories); }
  }

  async transfer(argv: string[], timeoutMs: number, source?: ImportSourceProps): Promise<CommandResult> {
    const container = this.ctx.container;
    const repositories = this.#repositories;
    if (!container?.running || !repositories) throw new Error('Sandbox is not prepared');
    if (source) {
      const outbound = this.ctx.exports.ImportOutbound({ props: source });
      await container.interceptAllOutboundHttp(outbound);
      await container.interceptOutboundHttps('*', outbound);
    }
    try { return await this.#executeCommand(argv, '/workspace', timeoutMs, 600_000); }
    finally { if (source) await this.#restrictToGit(repositories); }
  }

  async beginUrlImport(job: UrlImportJob, authorization?: string): Promise<{ started: boolean }> {
    return beginUrlImportJob(this.ctx.storage, this.#importCredentials, job, authorization);
  }

  async #bootstrapCommand(stage: string, script: string, timeoutMs = 120_000): Promise<void> {
    console.info('runner.bootstrap.stage', stage, 'started');
    const result = await this.#executeCommand(['/bin/sh', '-c', script], '/', timeoutMs, 300_000);
    console.info('runner.bootstrap.stage', stage, 'completed', result.exitCode);
    if (result.exitCode !== 0) throw new Error(`Runner bootstrap ${stage} failed (exit ${result.exitCode}): ${result.stdout.slice(-2000)}\n${result.stderr.slice(-2000)}`);
  }

  async command(argv: string[], cwd = '/workspace', timeoutMs = 60_000): Promise<CommandResult> {
    return this.#executeCommand(argv, cwd, timeoutMs, 120_000);
  }

  async check(script: string, timeoutMs: number): Promise<CommandResult> {
    return this.#executeCommand(['/bin/bash', '-lc', script], '/workspace/repo', timeoutMs, MAX_TEST_TIMEOUT_MS);
  }

  async collect(script: string, timeoutMs: number, capBytes: number): Promise<CommandResult> {
    return this.#executeCommand(['/bin/bash', '-lc', script], '/workspace/repo', timeoutMs, 300_000, Math.min(Math.max(capBytes, COMMAND_OUTPUT_CAP), BUNDLE_OUTPUT_CAP), true);
  }

  async #executeCommand(argv: string[], cwd: string, timeoutMs: number, maximumMs: number, cap = COMMAND_OUTPUT_CAP, strict = false, extraEnv: Record<string, string> = {}): Promise<CommandResult> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error('Sandbox is not running');
    const seconds = Math.max(1, Math.min(maximumMs, Math.floor(timeoutMs))) / 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tail = new OutputTail();
    const started = Date.now();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(deadlineMessage(argv, seconds * 1000, Date.now() - started, tail)));
        void Promise.resolve().then(() => container.destroy()).catch(() => { console.error('runner.command.timeout.cleanup.failed'); });
      }, seconds * 1000 + DEADLINE_GRACE_MS);
    });
    const execution = (async () => {
      const process = await container.exec(['timeout', '--kill-after=2s', `${seconds}s`, ...argv], {
        cwd,
        env: { GIT_SSL_CAINFO: ca, NODE_EXTRA_CA_CERTS: ca, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', CI: 'true', ...COREPACK_ENV, COREPACK_ENABLE_NETWORK: '0', ...extraEnv },
      });
      const observe = (chunk: Uint8Array) => tail.add(chunk);
      const [stdout, stderr, exitCode] = await Promise.all([readCappedOutput(process.stdout, cap, strict, observe), readCappedOutput(process.stderr, cap, strict, observe), process.exitCode]);
      const timedOut = TIMEOUT_EXIT_CODES.includes(exitCode) && Date.now() - started >= seconds * 1000 - 1000;
      return timedOut ? { stdout, stderr, exitCode, timedOut } : { stdout, stderr, exitCode };
    })();
    try { return await Promise.race([execution, timeout]); }
    finally { clearTimeout(timer); }
  }

  #previewPort: number | undefined;

  async startPreview(command: string | string[] = 'node src/preview.mjs', readinessMs = 15_000): Promise<number> {
    const container = this.ctx.container;
    if (!container?.running) throw new Error('Preview container is not running');
    const controller = new AbortController();
    const argv = Array.isArray(command) ? command : ['/bin/bash', '-lc', `exec ${command}`];
    const readLog = async (): Promise<string> => {
      let bound: ReturnType<typeof setTimeout> | undefined;
      const read = (async () => {
        const tail = await container.exec(['tail', '-c', '32768', PREVIEW_LOG], { cwd: '/' });
        const [output] = await Promise.all([readCappedOutput(tail.stdout, 32_768), tail.exitCode]);
        return output;
      })().catch(() => '');
      try { return await Promise.race([read, new Promise<string>((resolve) => { bound = setTimeout(() => resolve(''), LOG_READ_MS); })]); }
      finally { clearTimeout(bound); }
    };
    const fail = async (reason: string) => new Error(previewFailureMessage(reason, await readLog()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, readinessMs); });
    const seconds = Math.round(readinessMs / 1000);
    try {
      const process = await Promise.race([
        container.exec(['setsid', '/bin/bash', '-c', `echo $$ > ${PREVIEW_PID}; exec "$@" > ${PREVIEW_LOG} 2>&1`, 'preview', ...argv], { cwd: '/workspace/repo', env: { ...COREPACK_ENV, COREPACK_ENABLE_NETWORK: '0', PORT: String(PREVIEW_PORT), HOST: '0.0.0.0', BROWSER: 'none', WRANGLER_SEND_METRICS: 'false' }, stdout: 'ignore', stderr: 'ignore' }),
        timeout,
      ]);
      if (process === 'timeout') throw await fail(`Preview process did not start within ${seconds} seconds`);
      const exited = process.exitCode.then((code) => ({ exited: code }));
      let detected: number | null = null;
      const silent = (port: number | null) => fail(`Preview did not answer HTTP on port ${[...new Set([PREVIEW_PORT, port ?? PREVIEW_PORT])].join(' or ')} within ${seconds} seconds`);
      let polledAt = 0;
      for (;;) {
        if (Date.now() - polledAt >= LOG_POLL_MS) {
          polledAt = Date.now();
          detected = detectListeningPort(await readLog()) ?? detected;
        }
        for (const port of [...new Set([detected ?? PREVIEW_PORT, PREVIEW_PORT])]) {
          const response = await Promise.race([
            container.getTcpPort(port).fetch(new Request(`${previewHost(port)}/`, { signal: controller.signal, redirect: 'manual' })).catch(() => null),
            exited,
            timeout,
          ]);
          if (response === 'timeout') throw await silent(detected);
          if (response && 'exited' in response) throw await fail(`Preview process exited before readiness (exit ${response.exited})`);
          if (response) {
            await response.body?.cancel();
            if (response.status < 500) {
              this.#previewPort = port;
              await this.ctx.storage.put('preview-port', port);
              return port;
            }
          }
        }
        const waited = await Promise.race([new Promise<'retry'>((resolve) => { retryTimer = setTimeout(() => resolve('retry'), 250); }), exited, timeout]);
        if (waited === 'timeout') throw await silent(detected);
        if (typeof waited === 'object') throw await fail(`Preview process exited before readiness (exit ${waited.exited})`);
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(retryTimer);
      controller.abort();
    }
  }

  async stopPreview(): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) return;
    const process = await container.exec(['/bin/bash', '-c', STOP_PREVIEW_SCRIPT], { cwd: '/', stdout: 'ignore', stderr: 'ignore' });
    await process.exitCode;
    this.#previewPort = undefined;
    await this.ctx.storage.delete('preview-port');
  }

  async fetch(request: Request): Promise<Response> {
    return this.preview(request);
  }

  async preview(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container?.running) return new Response('Preview has expired', { status: 410 });
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of ['authorization', 'cookie', 'host', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port']) headers.delete(name);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
    headers.set('forwarded', `host="${url.host}";proto=${url.protocol.slice(0, -1)}`);
    this.#previewPort ??= await this.ctx.storage.get<number>('preview-port') ?? PREVIEW_PORT;
    const port = this.#previewPort;
    const response = await container.getTcpPort(port).fetch(new Request(`${previewHost(port)}${url.pathname}${url.search}`, { method: request.method, headers, body: request.body, redirect: 'manual' }));
    const location = response.headers.get('location');
    const local = location ? LOCAL_PREVIEW_ORIGIN.exec(location) : null;
    if (!local || response.webSocket) return response;
    const rewritten = new Response(response.body, response);
    rewritten.headers.set('location', `${url.origin}${local[1] ?? ''}`);
    return rewritten;
  }

  async expireAt(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    const pending = await this.ctx.storage.get<{ state?: string }>('url-import');
    if (pending && pending.state !== 'done') return resumeUrlImportJob(this.ctx.storage, this.#importCredentials, this, importJobDependencies(this.env));
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }

  async destroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }
}

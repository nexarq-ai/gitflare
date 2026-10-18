import type { CloudflareDeployAccess } from './cloudflare-deploy';
import { hasScope } from '../shared/cloudflare-permissions';
import type { PreviewHost } from './coordinator';
import { settingsTargets, type DeploySettings } from './deployments';
import { accessScopeState, type AccessScopeEnv } from './preview-access';
import type { PreviewSettings } from './preview-settings';
import { parseWranglerConfig } from './deploy-detect';
import { createPreviewWorker, probePreviewWorker, WorkerPreviewError, type Fetcher, type WorkerPreviewsConfig } from './worker-previews';
import { WORKER_CONFIG_FILES } from './worker-bundle';

export const WORKERS_SCRIPTS_EDIT_SCOPE = 'workers-scripts.edit';

export interface PreviewTarget { workerName: string; configPath?: string; accountId?: string }
export interface ProjectWorkers { accountId: string; workers: string[] }
export interface PreviewHostPlan { host: PreviewHost | null; config: WorkerPreviewsConfig | null; configPath?: string; notes: string[]; containerReason?: string }
export interface PreviewHostDeps {
  connection(target: PreviewTarget): Promise<CloudflareDeployAccess | null>;
  installation(): Promise<WorkerPreviewsConfig | null>;
  fetcher?: Fetcher;
}

const rootConfig = (path: string) => !path || (WORKER_CONFIG_FILES as readonly string[]).includes(path);

export function previewTarget(settings: Pick<PreviewSettings, 'targetWorker'>, deploy: DeploySettings | null, project: ProjectWorkers | null): PreviewTarget | null {
  const environment = deploy?.environments.production ?? deploy?.environments.staging;
  const targets = environment ? settingsTargets(environment) : [];
  const accountId = environment?.accountId ?? project?.accountId;
  const withConfig = (workerName: string): PreviewTarget => {
    const configPath = targets.find((target) => target.workerName === workerName)?.configPath;
    return { workerName, ...(configPath ? { configPath } : {}), ...(accountId ? { accountId } : {}) };
  };
  if (settings.targetWorker) return withConfig(settings.targetWorker);
  const root = targets.find((target) => rootConfig(target.configPath)) ?? (targets.length === 1 ? targets[0] : undefined);
  if (root) return withConfig(root.workerName);
  if (project?.workers.length === 1) return withConfig(project.workers[0]);
  return null;
}

const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function candidateWorkerTarget(read: (path: string) => Promise<string | null>): Promise<PreviewTarget | null> {
  for (const configPath of WORKER_CONFIG_FILES) {
    const content = await read(configPath).catch(() => null);
    if (content === null) continue;
    try {
      const name = parseWranglerConfig(configPath, content).name;
      return typeof name === 'string' && WORKER_NAME.test(name) ? { workerName: name, configPath } : null;
    } catch { return null; }
  }
  return null;
}

export const PREVIEWS_PERMISSION_HINT = 'grant the Previews permission in Settings → Cloudflare to use Worker Previews';

export function containerFallbackNote(reason: string, hint = true): string {
  return `Using a preview container because ${reason.replace(/\.+$/, '')}${hint ? `; ${PREVIEWS_PERMISSION_HINT}` : ''}.`;
}

export async function resolvePreviewHost(env: AccessScopeEnv, settings: Pick<PreviewSettings, 'access'>, target: PreviewTarget | null, deps: PreviewHostDeps): Promise<PreviewHostPlan> {
  const notes: string[] = [];
  const protectedPreview = settings.access === 'cloudflare-access';
  if (target) {
    const access = await deps.connection(target).catch(() => null);
    if (!access) notes.push(`No Cloudflare connection for this repository or workspace can reach Worker ${target.workerName}.`);
    else if (!hasScope(access.scopes, WORKERS_SCRIPTS_EDIT_SCOPE)) notes.push(`The ${access.source} Cloudflare connection was not granted ${WORKERS_SCRIPTS_EDIT_SCOPE}, so it cannot create Previews of ${target.workerName}.`);
    else if (protectedPreview && !accessScopeState(env, access.scopes).granted) notes.push('Cloudflare Access is selected, but the connection cannot manage Access applications.');
    else {
      const config: WorkerPreviewsConfig = { accountId: access.accountId, workerName: target.workerName, token: access.accessToken, connection: access.source };
      const hosted = (): PreviewHostPlan => ({ host: { kind: 'connection', source: access.source, accountId: access.accountId, workerName: target.workerName, access: settings.access }, config, ...(target.configPath ? { configPath: target.configPath } : {}), notes });
      const probe = await probePreviewWorker(config, deps.fetcher);
      if (probe === 'exists') return hosted();
      if (probe === 'missing') {
        try {
          await createPreviewWorker(config, deps.fetcher);
          notes.push(`Worker ${target.workerName} did not exist on account ${access.accountId}, so Gitflare created it with workers.dev and Previews enabled to host this Worker Preview.`);
          return hosted();
        } catch (error) {
          if (!(error instanceof WorkerPreviewError)) throw error;
          notes.push(`Worker ${target.workerName} does not exist on account ${access.accountId} and the ${access.source} Cloudflare connection could not create it (${error.status ? `HTTP ${error.status}` : error.code}).`);
        }
      } else notes.push(`The ${access.source} Cloudflare connection was refused for Worker ${target.workerName}.`);
    }
  }
  if (protectedPreview) {
    notes.push('Cloudflare Access is required for this repository, so the preview runs in the members-only preview container instead.');
    return { host: null, config: null, notes, containerReason: notes.join(' ') };
  }
  const installation = await deps.installation();
  if (!installation) return { host: null, config: null, notes, containerReason: notes.length ? notes.join(' ') : target ? 'no Cloudflare connection with Worker Previews is available for this repository' : 'no Worker was found to preview' };
  return { host: { kind: 'installation', accountId: installation.accountId, workerName: installation.workerName, access: 'link' }, config: installation, notes };
}

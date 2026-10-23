import type { Repository } from '../../shared/types';
import { validGitSha } from '../artifacts';
import { classifyPreview, LEGACY_PREVIEW, previewPlan, workerPreviewBuildCommand } from '../preview-plan';
import { containerFallbackNote } from '../preview-host';
import { PREVIEW_FAILURE_MAX, type PreviewStep } from '../../shared/preview-progress';
import { assertWorkerSources, buildWorkerBundle, DEPLOY_BUILD_TIMEOUT_MS, deployBuildScript, ensureWrangler, readWorkerConfig, WorkerBuildFailure, workerConfigPath, wranglerNote, type BundleSandbox, type ResolvedWorkerConfig, type WorkerBundle } from '../worker-bundle';
import { collectAndUploadAssets, type AssetsOptions } from '../worker-assets';
import { migrationDatabases, readMigrationFiles, type D1MigrationSet } from '../d1-migrations';
import { previewD1Migrations } from '../preview-d1';
import type { BuiltTarget } from '../deployments';
import { type ExecutionEnv, type AuthorityGuard, unrestricted } from './environment';
import { checked, clone } from './sandbox-git';
import { loadPolicy } from './verify';
import { workingTreeInstall, installDependencies } from './dependencies';
import type { IntegrationInput } from './integration';

function containerReason(configuredCommand: string | undefined, workerPreviews: boolean, unavailable: string | undefined): string {
  if (configuredCommand && configuredCommand !== LEGACY_PREVIEW) return containerFallbackNote('the repository policy sets its own preview command', false);
  if (!workerPreviews) return containerFallbackNote(unavailable ?? 'Worker Previews are not configured for this repository');
  return containerFallbackNote('the Wrangler config has no main entry, so there is no Worker to preview', false);
}

export class PreviewFailure extends Error {
  constructor(message: string) {
    super(message.slice(0, PREVIEW_FAILURE_MAX));
    this.name = 'PreviewFailure';
  }
}

export interface BuiltPreview { bundle: WorkerBundle; uploadAssets?: BuiltTarget['uploadAssets']; d1?: D1MigrationSet[] }

export type PreparedPreview<T = undefined> = { kind: 'container'; sandboxName: string; candidateSha: string; notes: string[] } | { kind: 'worker'; bundle: WorkerBundle; candidateSha: string; published?: T };

function workerAssetsOptions(config: ResolvedWorkerConfig): AssetsOptions | null {
  if (!config.assets) return null;
  const assets = config.deploy?.assets;
  if (!assets || typeof assets !== 'object' || typeof (assets as Record<string, unknown>).directory !== 'string') throw new WorkerBuildFailure('WORKER_ASSETS_DIRECTORY_INVALID', 'The assets directory must be inside the repository.');
  return assets as AssetsOptions;
}

function uploadsAssets(sandbox: BundleSandbox, options: AssetsOptions | null): Pick<BuiltPreview, 'uploadAssets'> {
  return options ? { uploadAssets: (call, accountId, workerName) => collectAndUploadAssets(sandbox, { call, accountId, workerName, options }) } : {};
}

export async function prepareCandidatePreview<T = undefined>(env: ExecutionEnv, { mission, previewAttemptId, assertAuthority = unrestricted, workerPreviews = false, workerPreviewsUnavailable, configPath: preferredConfig, publishWorker, onStep = async () => {} }: IntegrationInput & { previewAttemptId: string; workerPreviews?: boolean; workerPreviewsUnavailable?: string; configPath?: string; publishWorker?: (built: BuiltPreview) => Promise<T>; onStep?: (step: PreviewStep) => Promise<void> }): Promise<PreparedPreview<T>> {
  if (mission.authorization && assertAuthority === unrestricted) throw new Error('Preview authority guard is required');
  if (!/^[a-f0-9-]{36}$/.test(previewAttemptId)) throw new Error('Invalid preview attempt ID');
  if (!env.ARTIFACTS || !env.SANDBOX || !mission.candidateSha || !mission.integrationForkName) throw new Error('A real integration candidate is required for preview');
  await assertAuthority();
  using repositoryHandle = await env.ARTIFACTS.get(mission.integrationForkName);
  const fork = await repositoryHandle.info();
  const sandboxName = `preview-${mission.id}-${previewAttemptId}`;
  const sandbox = env.SANDBOX.getByName(sandboxName);
  if (!sandbox.startPreview) throw new Error('Preview runner is unavailable');
  try {
    await assertAuthority();
    await onStep('cloning');
    await sandbox.prepare([{ ...fork, write: false }]);
    await clone(sandbox, fork, mission.candidateSha);
    const policy = mission.baseSha ? await loadPolicy(sandbox, mission.baseSha, '') : undefined;
    const files = (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter(Boolean);
    let installed = false;
    const configPath = preferredConfig && files.includes(preferredConfig) ? preferredConfig : workerConfigPath(files);
    if (configPath && classifyPreview(files, { main: configPath }, { workerPreviews, configuredCommand: policy?.previewCommand }) === 'worker') {
      let built: BuiltPreview | null = null;
      try {
        const { plan, packageJson } = await workingTreeInstall(sandbox, files);
        if (plan) {
          await onStep('installing');
          await installDependencies(sandbox, plan, assertAuthority, async () => true);
        }
        installed = true;
        await assertAuthority();
        await ensureWrangler(sandbox, configPath);
        let config = await readWorkerConfig(sandbox, configPath);
        const assetsDirectory = config?.deploy?.assets && typeof config.deploy.assets === 'object' ? (config.deploy.assets as Record<string, unknown>).directory : undefined;
        const buildCommand = workerPreviewBuildCommand(files, packageJson, typeof assetsDirectory === 'string' ? assetsDirectory : null, plan);
        if (buildCommand) {
          await onStep('building');
          if (!sandbox.check) throw new WorkerBuildFailure('WORKER_BUILD_UNAVAILABLE', 'The runner cannot run build commands.');
          await assertAuthority();
          const result = await sandbox.check(deployBuildScript(buildCommand), DEPLOY_BUILD_TIMEOUT_MS);
          if (result.exitCode !== 0) throw new WorkerBuildFailure('PREVIEW_BUILD_FAILED', `${buildCommand} failed (exit ${result.exitCode}${result.timedOut ? ', timed out' : ''}). ${(result.stderr || result.stdout).replace(/\s+/g, ' ').trim().slice(-500)}`);
          config = await readWorkerConfig(sandbox, configPath, true);
        }
        if (config && classifyPreview(files, config, { workerPreviews, configuredCommand: policy?.previewCommand }) === 'worker') {
          assertWorkerSources(config, { commitSha: mission.candidateSha, built: !!buildCommand });
          const assets = workerAssetsOptions(config);
          await assertAuthority();
          const d1 = previewD1Migrations(config);
          built = { bundle: await buildWorkerBundle(sandbox, config), ...uploadsAssets(sandbox, assets) };
          if (d1.length) built.d1 = await readMigrationFiles(sandbox, d1);
        }
      } catch (error) {
        throw new PreviewFailure(`Worker preview could not be built. ${error instanceof Error ? error.message : 'The Worker build failed.'}`);
      }
      if (built) {
        let published: T | undefined;
        try {
          await assertAuthority();
          await onStep('publishing');
          if (publishWorker) published = await publishWorker(built);
        } catch (error) {
          throw new PreviewFailure(`Worker preview could not be published. ${error instanceof Error ? error.message : 'Cloudflare rejected the preview.'}`);
        }
        await sandbox.destroy();
        return { kind: 'worker', bundle: built.bundle, candidateSha: mission.candidateSha, ...(publishWorker ? { published } : {}) };
      }
    }
    const { packageJson, lockHead } = await workingTreeInstall(sandbox, files);
    const notes = configPath ? [containerReason(policy?.previewCommand, workerPreviews, workerPreviewsUnavailable)] : [];
    const plan = previewPlan(files, packageJson, { command: policy?.previewCommand, install: policy?.install }, lockHead);
    try {
      if (plan.install && !installed) {
        await onStep('installing');
        await installDependencies(sandbox, plan.install, assertAuthority, async () => true);
      }
      await assertAuthority();
      await onStep('starting');
      await sandbox.startPreview(plan.argv, plan.readinessMs);
    } catch (error) {
      throw new PreviewFailure(`${notes.length ? `${notes[0]} ` : ''}Preview could not start using ${plan.description}. ${error instanceof Error ? error.message : 'The preview process failed.'}`);
    }
    return { kind: 'container', sandboxName, candidateSha: mission.candidateSha, notes };
  } catch (error) {
    await sandbox.destroy();
    if (error instanceof PreviewFailure) throw error;
    throw new PreviewFailure(`Preview could not prepare the candidate. ${error instanceof Error ? error.message : 'The preview runner failed.'}`);
  }
}

export interface DeployBuildTarget { configPath: string; buildCommand?: string; d1Migrations: boolean }

export interface LandedWorkerInput { repository: Repository; commitSha: string; attemptId: string; assertAuthority: AuthorityGuard; target?: DeployBuildTarget; index?: number; environment?: string }

export async function buildLandedWorker<T = BuiltTarget>(env: ExecutionEnv, { repository, commitSha, attemptId, assertAuthority, target, index = 0, environment }: LandedWorkerInput, publish: (built: BuiltTarget) => Promise<T> = async (built) => built as T): Promise<T> {
  if (!/^[a-f0-9-]{36}$/.test(attemptId)) throw new Error('Invalid deployment attempt ID');
  if (!validGitSha(commitSha)) throw new WorkerBuildFailure('DEPLOY_COMMIT_INVALID', 'Deployments need an exact landed commit.');
  if (!env.ARTIFACTS || !env.SANDBOX) throw new WorkerBuildFailure('DEPLOY_RUNNER_UNAVAILABLE', 'Artifacts and the sandbox runner are required to build a deployment.');
  await assertAuthority();
  using canonical = await env.ARTIFACTS.get(repository.name);
  const info = await canonical.info();
  const sandbox = env.SANDBOX.getByName(index ? `deploy-${repository.id}-${attemptId}-${index}` : `deploy-${repository.id}-${attemptId}`);
  try {
    await sandbox.prepare([{ ...info, write: false }]);
    await clone(sandbox, info, commitSha);
    const files = (await checked(sandbox, ['git', 'ls-files'])).split('\n').filter(Boolean);
    const configPath = target?.configPath || workerConfigPath(files);
    if (!configPath) throw new WorkerBuildFailure('WORKER_CONFIG_REQUIRED', 'The landed commit has no wrangler.jsonc, wrangler.json or wrangler.toml.');
    if (!files.includes(configPath)) throw new WorkerBuildFailure('WORKER_CONFIG_REQUIRED', `The landed commit has no ${configPath}.`);
    const { plan } = await workingTreeInstall(sandbox, files);
    if (plan) await installDependencies(sandbox, plan, assertAuthority, async () => true);
    await assertAuthority();
    await ensureWrangler(sandbox, configPath);
    if (target?.buildCommand) {
      if (!sandbox.check) throw new WorkerBuildFailure('WORKER_BUILD_UNAVAILABLE', 'The runner cannot run build commands.');
      await assertAuthority();
      const built = await sandbox.check(deployBuildScript(target.buildCommand, environment), DEPLOY_BUILD_TIMEOUT_MS);
      if (built.exitCode !== 0) throw new WorkerBuildFailure('DEPLOY_BUILD_FAILED', `${target.buildCommand} failed (exit ${built.exitCode}${built.timedOut ? ', timed out' : ''}). ${(built.stderr || built.stdout).replace(/\s+/g, ' ').trim().slice(-500)}`);
    }
    const config = await readWorkerConfig(sandbox, configPath, !!target, target ? environment : undefined);
    if (!config) throw new WorkerBuildFailure('WRANGLER_UNAVAILABLE', `Wrangler could not read ${configPath}: the repository does not depend on wrangler and Gitflare’s Wrangler is not installed.`, 'Add wrangler to devDependencies in package.json.');
    assertWorkerSources(config, { commitSha, built: !!target?.buildCommand });
    await assertAuthority();
    const bundle = await buildWorkerBundle(sandbox, config);
    const migrations = target?.d1Migrations ? await readMigrationFiles(sandbox, migrationDatabases(config.deploy?.d1_databases)) : [];
    const note = wranglerNote(config);
    return await publish({ bundle, migrations, ...uploadsAssets(sandbox, workerAssetsOptions(config)), ...(note ? { notes: [note] } : {}) });
  } finally {
    try { await sandbox.destroy(); }
    catch { console.error('runner.deploy.cleanup.failed', repository.id); }
  }
}

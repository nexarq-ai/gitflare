import type { Repository, RepositoryVisualSettings, VisualSettings } from '../../shared/types';
import type { ArtifactsBinding } from '../artifacts';
import { ApiError } from '../domain';
import { POLICY_FILE } from '../repository-policy';
import { effectiveVisualConfig, MAX_VISUAL_ROUNDS, MAX_VISUAL_ROUTES, MAX_VISUAL_STEPS, parseVisualSettings } from './config';

const POLICY_LIMIT = 65_536;

export async function policyVisualSettings(artifacts: ArtifactsBinding | undefined, repository: Pick<Repository, 'name' | 'provider' | 'defaultBranch'>, ref?: string): Promise<{ settings: VisualSettings | null; problem?: string }> {
  if (!artifacts || repository.provider !== 'artifacts') return { settings: null };
  try {
    using source = await artifacts.get(repository.name);
    const blob = await source.readFile({ ref: ref ?? repository.defaultBranch, path: POLICY_FILE });
    if (!blob || blob.size > POLICY_LIMIT) return { settings: null };
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer())) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.visual === undefined) return { settings: null };
    return { settings: parseVisualSettings(parsed.visual) };
  } catch (error) { return { settings: null, problem: `${POLICY_FILE}: ${error instanceof Error ? error.message : 'could not be read'}` }; }
}

export function visualSettingsSnapshot(repositoryId: string, stored: VisualSettings | undefined | null, policy: VisualSettings | null, problem?: string): RepositoryVisualSettings & { policyProblem?: string } {
  return { repositoryId, ...(stored ?? {}), effective: effectiveVisualConfig(policy, stored), limits: { maxRoutes: MAX_VISUAL_ROUTES, maxSteps: MAX_VISUAL_STEPS, maxRounds: MAX_VISUAL_ROUNDS }, ...(problem ? { policyProblem: problem } : {}) };
}

export function visualSettingsInput(body: Record<string, unknown>): VisualSettings {
  const fields: Record<string, unknown> = {};
  for (const key of ['routes', 'viewports', 'themes', 'checks', 'quality'] as const) if (body[key] !== undefined && body[key] !== null) fields[key] = body[key];
  const unknown = Object.keys(body).find((key) => !['routes', 'viewports', 'themes', 'checks', 'quality'].includes(key));
  if (unknown) throw new ApiError(400, 'INVALID_INPUT', `${unknown} is not a visual setting.`);
  try { return parseVisualSettings(fields, 'settings'); }
  catch (error) { throw new ApiError(400, 'INVALID_INPUT', error instanceof Error ? `${error.message}.` : 'Invalid visual settings.'); }
}

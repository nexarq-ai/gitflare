import { DESIGN_REVIEWER_ID, type Mission, type ModelConnection, type VisualCapture, type VisualEvidence, type VisualRound } from '../../shared/types';
import { modelStrength } from '../../shared/mission-draft';
import { createModelAccess } from '../ai-keys';
import { catalogName } from '../capacity';
import type { AppEnv } from '../env';
import { publicError } from '../domain';
import { assertPinnedModel } from '../model-config';
import { records } from '../route-context';
import { captureHeading, type ToolImage } from './agent-view';
import { critique, designReviewBody, strongestModel } from './critic';
import { DEFAULT_VISUAL_QUALITY } from './config';
import { hasDesignContext, loadDesignContext, type DesignContext } from './design-context';

const MAX_REVIEW_IMAGES = 8;

export function reviewableEvidence(mission: Mission): VisualEvidence | undefined {
  const candidates = (mission.visual ?? []).filter((item) => item.candidateSha === mission.candidateSha && !item.rounds);
  return candidates.find((item) => !item.runId) ?? candidates.find((item) => item.runId === mission.selectedRunId) ?? candidates[0];
}

export function designReviewWanted(mission: Mission, design: DesignContext | null): boolean {
  return mission.status === 'needs_review' && !!mission.candidateSha && !!mission.baseSha && (!!mission.qualityBar || hasDesignContext(design)) && !(mission.reviews ?? []).some((review) => review.authorId === DESIGN_REVIEWER_ID && review.candidateSha === mission.candidateSha && review.epoch === mission.epoch);
}

export function reviewText(evidence: VisualEvidence, captures: VisualCapture[]): string {
  return [`Candidate ${evidence.candidateSha.slice(0, 12)} against base ${evidence.baseSha.slice(0, 12)}; ${evidence.mode === 'browser' ? `captured with ${evidence.browser ?? 'Chromium'}` : 'no browser was available, outlines only'}.`, ...captures.map((capture, index) => `## ${index + 1}. ${captureHeading(capture)}${capture.diff ? ` · ${(capture.diff.changedRatio * 100).toFixed(1)}% changed from the base` : ''}\n${capture.outline}${capture.consoleErrors.length ? `\nConsole errors: ${capture.consoleErrors.slice(0, 5).join(' | ')}` : ''}${capture.overflow > 0 ? `\nLayout overflow: ${capture.overflow}px` : ''}`)].join('\n\n').slice(0, 16_000);
}

export async function runDesignReview(env: AppEnv, repositoryId: string, missionId: string): Promise<Mission | null> {
  const repo = records(env, repositoryId);
  const [mission, repository] = await Promise.all([repo.getMission(missionId), repo.getRepository(repositoryId)]);
  if (!mission || !repository || !mission.candidateSha || !mission.baseSha) return null;
  let design: DesignContext | null = null;
  if (env.ARTIFACTS && repository.provider === 'artifacts') {
    using source = await env.ARTIFACTS.get(repository.name);
    design = await loadDesignContext(source, mission.baseSha);
  }
  if (!designReviewWanted(mission, design)) return null;
  const evidence = reviewableEvidence(mission);
  if (!evidence) return null;
  const candidateCaptures = evidence.captures.filter((capture) => capture.side === 'candidate');
  if (!candidateCaptures.length) return null;
  const workspaceId = repository.workspaceId ?? 'legacy';
  const catalog = env.GITFLARE_COORDINATOR.getByName(catalogName(workspaceId));
  const models = await catalog.getModelConnections();
  const pinned = mission.runs.flatMap((run) => run.modelConfig ? [run.modelConfig] : []);
  const model: ModelConnection | undefined = strongestModel([...models.filter((entry) => entry.verification?.status === 'verified'), ...pinned], modelStrength) ?? pinned[0];
  if (!model) return null;
  assertPinnedModel(models, model);
  const images: ToolImage[] = [];
  for (const capture of candidateCaptures.slice(0, MAX_REVIEW_IMAGES)) {
    const stored = await repo.visualImage(mission.id, capture.id);
    if (stored) images.push({ id: capture.id, mimeType: stored.format === 'jpeg' ? 'image/jpeg' : 'image/png', data: stored.data, label: captureHeading(capture) });
  }
  const passScore = DEFAULT_VISUAL_QUALITY.passScore;
  const verdict = await critique({ ...env, modelAccess: createModelAccess(env, workspaceId, catalog) }, model, { title: mission.title, prompt: mission.prompt, qualityBar: mission.qualityBar, design, round: 1, rounds: 1, passScore }, reviewText(evidence, candidateCaptures), images);
  const round: VisualRound = { round: 1, score: verdict.score, critique: verdict.critique, fixes: verdict.fixes, captureIds: images.map((image) => image.id), model: model.id, at: new Date().toISOString() };
  const earlier = (mission.visual ?? []).filter((item) => item.candidateSha === mission.candidateSha).flatMap((item) => item.rounds ?? []);
  return repo.addAgentReview(mission.id, mission.epoch, mission.candidateSha, mission.baseSha, designReviewBody([...earlier, round], passScore, mission.qualityBar), DESIGN_REVIEWER_ID);
}

export async function autoDesignReview(env: AppEnv, repositoryId: string, missionId: string): Promise<void> {
  try {
    if (env.DEMO_MODE === 'true') return;
    await runDesignReview(env, repositoryId, missionId);
  } catch (error) { console.warn(JSON.stringify({ event: 'auto_design_review_failed', repositoryId, missionId, code: publicError(error).code })); }
}

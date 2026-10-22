import type { Mission, MissionAttempt, MissionEvent, Repository } from '../shared/types';
import { ApiError, assertReplayFingerprint, failureLine } from './domain';
import { assertDependenciesAcknowledged } from './dependency-changes';
import { activeLandingMessage } from '../shared/commit-message';
import type { SqlStore } from './store';
import type { Principal } from './security';
import { assertReviewClear } from './proposal-review';
import { validGitSha } from './artifacts';
import { type Receipt, type IntegrationClaim, INTEGRATION_PREPARATION_MS, INTEGRATION_UNCONFIRMED_MESSAGE, type CoordinatorHost } from './coordinator-types';

const minutes = (ms: number) => Math.ceil(ms / 60_000);

const landingCause = (reason: string) => failureLine(reason).replace(/\.$/, '');

export function integrationPendingMessage(candidateSha: string): string {
  return `Landing has not finished: the default branch has not yet confirmed commit ${candidateSha.slice(0, 12)}, so other proposals in this repository cannot land until it does. If landing started in the last ${minutes(INTEGRATION_PREPARATION_MS)} minutes, wait and choose Land again; retries never push twice. If it has been longer, ask a workspace Owner to check the default branch: once it shows ${candidateSha.slice(0, 12)}, choose Land again to record it.`;
}

export class IntegrationBook {
  private readonly ctx: DurableObjectState;

  constructor(private readonly host: CoordinatorHost) {
    this.ctx = host.ctx;
  }

  private get store(): SqlStore { return this.host.store; }

  private requiredMission(id: string): Mission { return this.host.requiredMission(id); }
  private saveMission(mission: Mission, message?: string, type?: MissionEvent['type']): Mission { return this.host.saveMission(mission, message, type); }
  private archive(mission: Mission, reason: MissionAttempt['reason']): void { return this.host.archive(mission, reason); }
  private getRepository(id: string): Repository | undefined { return this.host.getRepository(id); }
  private saveRepository(repository: Repository): void { return this.host.saveRepository(repository); }
  private recordContributorLanding(mission: Mission): void { return this.host.recordContributorLanding(mission); }
  private recordLinkedIssues(mission: Mission, sha: string): void { return this.host.recordLinkedIssues(mission, sha); }

  beginIntegration(key: string, id: string, candidateSha: string, baseSha: string, commitMessage?: string, actorId = 'workspace-owner', vouch?: Principal): { mission: Mission; claimed: boolean; claimId?: string; landedSha?: string } {
    return this.ctx.storage.transactionSync(() => {
      const fingerprint = JSON.stringify(['integrate', id, candidateSha, baseSha, ...(commitMessage === undefined ? [] : [commitMessage])]);
      const receipt = this.store.get<Receipt<boolean>>(`request:${key}`);
      if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
      const mission = this.requiredMission(id);
      if (mission.candidateSha !== candidateSha || mission.baseSha !== baseSha || !mission.approvedAt) throw new ApiError(409, 'STALE_APPROVAL', 'Approve this exact candidate and base before integration.');
      if (mission.status === 'integrated') return { mission, claimed: false };
      assertReviewClear(mission);
      if (!['approved', 'integrating'].includes(mission.status)) throw new ApiError(409, 'APPROVAL_REQUIRED', 'Approve this candidate before integration.');
      assertDependenciesAcknowledged(mission, candidateSha, baseSha);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (claim) {
        if (claim.missionId !== id || claim.epoch !== mission.epoch || claim.candidateSha !== candidateSha) throw new ApiError(409, 'INTEGRATION_BUSY', 'Another integration is in progress for this repository.');
        if (commitMessage !== undefined && commitMessage !== activeLandingMessage(mission)) throw new ApiError(409, 'LANDING_MESSAGE_LOCKED', 'Landing already started with another commit message. Wait for it to finish.');
        if (!claim.claimId) {
          claim.claimId = crypto.randomUUID();
          this.store.put('integration:claim', claim);
        }
        return { mission, claimed: false, claimId: claim.claimId, ...(claim.landedSha ? { landedSha: claim.landedSha } : {}) };
      }
      if (this.getRepository(mission.repositoryId)?.headSha !== baseSha) throw new ApiError(409, 'STALE_APPROVAL', 'The repository changed after approval. Run and review the change again.');
      if (!mission.integrationForkName || !mission.checks.some((check) => check.candidateSha === candidateSha && check.status === 'passed') || mission.checks.some((check) => check.status !== 'passed')) throw new ApiError(409, 'CHECKS_REQUIRED', 'The exact candidate must have passing verification and an integration fork.');
      const claimId = crypto.randomUUID();
      this.store.put('integration:claim', { claimId, missionId: id, epoch: mission.epoch, candidateSha, baseSha, claimedAt: Date.now(), phase: 'preparing' });
      this.store.put(`request:${key}`, { fingerprint, result: true });
      if (vouch && mission.branchChange?.source) this.store.put(`vouch:${id}`, vouch);
      mission.status = 'integrating';
      delete mission.error;
      if (commitMessage !== undefined) mission.landingMessage = { message: commitMessage, candidateSha, baseSha, epoch: mission.epoch, setBy: actorId, setAt: new Date().toISOString() };
      return { mission: this.saveMission(mission, `Integrating approved commit ${candidateSha.slice(0, 12)} into the default branch.`), claimed: true, claimId };
    });
  }

  completeIntegration(id: string, epoch: number, sha: string, claimId: string): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (mission.status === 'integrated' && mission.epoch === epoch && (mission.landedSha ?? mission.candidateSha) === sha) return mission;
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== epoch || (claim.landedSha ?? claim.candidateSha) !== sha || mission.status !== 'integrating') throw new ApiError(409, 'STALE_EXECUTION', 'This integration report does not match the active claim.');
      const repository = this.getRepository(mission.repositoryId);
      if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
      this.saveRepository({ ...repository, headSha: sha, updatedAt: new Date().toISOString() });
      this.store.delete('integration:claim');
      mission.status = 'integrated';
      mission.landedSha = sha;
      delete mission.error;
      this.saveMission(mission, sha === claim.candidateSha ? `Verified canonical branch at approved commit ${sha.slice(0, 12)}.` : `Verified canonical branch at commit ${sha.slice(0, 12)}, which carries the approved tree of ${claim.candidateSha.slice(0, 12)} with the chosen commit message.`, 'success');
      this.archive(mission, 'integrated');
      this.recordLinkedIssues(mission, sha);
      this.recordContributorLanding(mission);
      return mission;
    });
  }

  claimIntegrationPush(id: string, epoch: number, claimId: string, landedSha?: string): void {
    this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== epoch || mission.epoch !== epoch || mission.status !== 'integrating' || claim.phase !== 'preparing') throw new ApiError(409, 'STALE_EXECUTION', 'This integration no longer owns a preparation claim.');
      if (claim.claimedAt === undefined || Date.now() - claim.claimedAt >= INTEGRATION_PREPARATION_MS) throw new ApiError(409, 'INTEGRATION_DEADLINE', 'Landing preparation expired before the canonical push.');
      if (landedSha !== undefined && !validGitSha(landedSha)) throw new ApiError(400, 'INVALID_COMMIT', 'The landing commit must be a full SHA.');
      claim.phase = 'pushing';
      if (landedSha && landedSha !== claim.candidateSha) claim.landedSha = landedSha;
      this.store.put('integration:claim', claim);
    });
  }

  releaseStaleIntegration(id: string, claimId: string): Mission | null {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== mission.epoch || mission.status !== 'integrating') return null;
      if (claim.phase !== 'preparing' || claim.claimedAt === undefined || Date.now() - claim.claimedAt < INTEGRATION_PREPARATION_MS) return null;
      this.store.delete('integration:claim');
      mission.status = 'approved';
      mission.error = 'Landing preparation expired before permission to push. Its fenced repository claim was released; retry landing.';
      this.saveMission(mission, mission.error, 'warning');
      this.archive(mission, 'integration_failed');
      return mission;
    });
  }

  retryIntegration(id: string, epoch: number, claimId: string, reason: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== epoch || mission.epoch !== epoch || mission.status !== 'integrating' || claim.phase !== 'preparing') return false;
      this.store.put('integration:claim', { ...claim, claimedAt: Date.now() });
      this.saveMission(mission, `Landing attempt 1 stopped before the canonical push (${landingCause(reason)}). Nothing was pushed and the default branch is unchanged, so landing is retrying once on a fresh runner.`, 'warning');
      return true;
    });
  }

  integrationFailed(id: string, epoch: number, claimId: string, outcome: 'not_pushed' | 'unknown', reason?: string): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      const claim = this.store.get<IntegrationClaim>('integration:claim');
      if (!claim || claim.claimId !== claimId || claim.missionId !== id || claim.epoch !== epoch || mission.status !== 'integrating') throw new ApiError(409, 'STALE_EXECUTION', 'This integration no longer owns the repository claim.');
      if (outcome === 'not_pushed') {
        this.store.delete('integration:claim');
        mission.status = 'approved';
        mission.error = `Integration stopped before attempting a canonical push${reason ? ` (${landingCause(reason)})` : ''}. Retry integration, or revoke approval to rerun this mission.`;
      } else {
        claim.phase = 'pushing';
        this.store.put('integration:claim', claim);
        mission.error = INTEGRATION_UNCONFIRMED_MESSAGE;
      }
      this.saveMission(mission, outcome === 'unknown' && reason ? `${mission.error} Cause: ${landingCause(reason)}.` : mission.error, 'warning');
      this.archive(mission, outcome === 'not_pushed' ? 'integration_failed' : 'integration_uncertain');
      return mission;
    });
  }

  integrationClaim(): IntegrationClaim | undefined { return this.store.get<IntegrationClaim>('integration:claim'); }
}

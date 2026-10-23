import { DurableObject } from 'cloudflare:workers';
import { AGENT_REVIEWER_ID, type AgentAssistSettings, type CommunityPool, type CommunityPoolUsage, type OperatorAiUse, type TriageSuggestion, type Advisory, type AgentRetryOverride, type AgentRun, type AgentSettings, type BranchChange, type BranchChangeResult, type CheckOverride, type CheckPlan, type CheckSettings, type CreateMissionInput, type IssueDetail, type IssueLabelDefinition, type IssueList, type Mission, type MissionAttempt, type MissionEvent, type MissionSummary, type ModelConnection, type OutsideChecksGate, type Release, type Repository, type RepositorySkillChange, type ReviewMissionInput } from '../shared/types';
import { ApiError, assertActiveRun, assertApproval, assertReplayFingerprint, failureLine, REVIEW_GUIDANCE_MAX } from './domain';
import { assertDependencyApprover } from './dependency-changes';
import { activeLandingMessage } from '../shared/commit-message';
import { repositoryLabel } from '../shared/repository-names';
import type { AppEnv } from './env';
import type { ExecutionResult } from './execution';
import { SqlStore } from './store';
import { assertDemoMode, DemoControlBook, type DemoControlState, type DemoCurrent } from './demo';
import { SecretLinkBook, type SecretLink, type SecretReceipt } from './repository-secrets';
import { securityClient, type Principal } from './security';
import { needsPacking, packMission, summarizeMission, unpackMission, type BlobStore } from './mission-storage';
import { assertLineInCandidate, assertReviewClear, currentReviewRequests, reviewMissionInput } from './proposal-review';
import { skillMissionInput, validateRepositorySkillChange } from './skill-edit';
import type { ImportReceipt, ImportResult } from './repository-import';
import { applyReleaseChange, type ReleaseChange, type ReleaseReceipt } from './releases';
import { assetUsage, chargeDownload, commitAsset, listAssets, removeAsset, removeReleaseAssets, type StoredAsset } from './release-assets';
import { advisoryFingerprint, applyAdvisoryChange, listAdvisories, type AdvisoryChange } from './advisories';
import { applyImportChange, importedPullMissions, importedReleaseIds, ORG_IMPORTS_KEPT, type ImportChange, type ImportChangeResult, type ImportRegistryEntry, type OrgImportRecord, type StoredImport } from './github-import';
import { defaultModelConnections, pinMissionModels, validateModelConnection } from './model-config';
import { readAssist, readPool, requesterRemaining, reservePool, poolUsage, publicPool, writeAssist, writePool, type PoolKind, type StoredPool } from './community-pool';
import { applyIssueChange, applyLabelChange, applyTriage, issueFingerprint, linkIssueMission, listIssues, listLabelDefinitions, readIssue, recordIssueOutcome, type IssueActor, type IssueChange, type IssueLabelChange, type IssueQuery } from './issues';
import { branchName, normalizeBranchRules, type StoredBranchProtection } from './branch-protection';
import { missionStepTimeoutMs } from './budgets';
import { effectiveAgentLimits, normalizeAgentSettings } from './agent-settings';
import { AUTO_INCREASE_ACTOR, checkDurations, checkPlan, DURATION_SAMPLES, normalizeCheckSettings, withLearnedLimits, type CheckSettingsInput, type LearnedLimits } from './check-settings';
import type { SavedDetection } from './deploy-detect';
import { DeployAccessBook, type DeployAccessRecord, type DeployAccessResult } from './deploy-access';
import { DeploymentLedger, type DeployEnvironment, type DeployEnvironmentSettings, type DeploymentRecord, type DeploymentStatus, type DeploySettings, type DeployState } from './deployments';
import type { AiCredentials, OperatorModelGrant, OperatorUsageKind, StoredAiGateway, StoredAiKey } from './ai-keys';
import { storedPreviewSettings, type PreviewSettings } from './preview-settings';
import { applyMirrorChange, type MirrorChange, type MirrorChangeResult, type StoredMirror } from './github-mirror';
import { NotificationBook, SubscriptionBook, type DigestEntry, type NotificationFilter, type NotificationRecord } from './notifications';
import { sendNotificationEmail } from './notification-email';
import type { NotificationEvent, NotificationPreferences, NotificationReason, NotificationSubject, ReviewRequests, SubscriptionState } from '../shared/notifications';
import { validGitSha } from './artifacts';
import type { Receipt, ContributorStanding, OutgoingProposal, MissionSummaryCache, CoordinatorHost } from './coordinator-types';
import { PreviewBook } from './coordinator-previews';
import { eligibleRaceRuns } from './preview-subject';
import { DispatchBook } from './coordinator-dispatch';
import { IntegrationBook } from './coordinator-integration';
import { CapacityBook } from './coordinator-capacity';

export { PREVIEW_LEASE_MS, PREVIEW_HEARTBEAT_MS, PREVIEW_READY_MS, WORKER_PREVIEW_TTL_MS, DISPATCH_FAST_ATTEMPTS, MISSION_WATCHDOG_MS, WATCHDOG_MISSING_LIMIT, INTEGRATION_UNCONFIRMED_MESSAGE, PREVIEW_STARTING_MESSAGE } from './coordinator-types';
export type { ContributorStanding, OutgoingProposal, MissionSummaryCache, IntegrationClaim, PreviewCapability, PreviewHost, WorkerPreviewInfo, PreviewLifetime, WorkerPreviewRecord, PreviewExtension, StoppedPreview, PreviewEndReason, LastPreview, PreviewStatus } from './coordinator-types';
export { integrationPendingMessage } from './coordinator-integration';

const BRANCH_MERGER = { name: 'Branch merger', role: 'Trusted branch merger' } as const;

export function branchMergerTask(change: Pick<BranchChange, 'branch' | 'headSha' | 'targetBranch'>): string {
  return `Merge ${change.branch} at ${change.headSha.slice(0, 12)} into ${change.targetBranch}, fast-forwarding when possible.`;
}

export function retaskBranchMerger(run: AgentRun, change: Pick<BranchChange, 'branch' | 'headSha' | 'targetBranch'>): AgentRun {
  const assignment = branchMergerTask(change);
  if (run.assignment === assignment) return run;
  const task = run.assignment && run.task.includes(run.assignment) ? run.task.replace(run.assignment, assignment) : run.task.replace(/Merge \S+ at [0-9a-f]{7,40} into \S+, fast-forwarding when possible\./, assignment);
  return { ...run, task, assignment };
}

function agentDefaults(overrides: CreateMissionInput['agentOverrides']): Pick<AgentRun, 'editScope' | 'overrides'> {
  if (!overrides) return {};
  const { editScope, ...limits } = overrides;
  return { ...(editScope?.length ? { editScope: [...editScope] } : {}), ...(Object.keys(limits).length ? { overrides: limits } : {}) };
}

function withRetryOverride(run: AgentRun, override: AgentRetryOverride | undefined): AgentRun {
  if (!override) return run;
  const { model, ...limits } = override;
  const next: AgentRun = { ...run, ...(Object.keys(limits).length ? { overrides: { ...run.overrides, ...limits } } : {}) };
  if (model && model !== run.model) { next.model = model; delete next.modelConfig; }
  return next;
}

function retryOverrideNote(runs: AgentRun[], overrides: Record<string, AgentRetryOverride> | undefined): string {
  if (!overrides) return '';
  const notes = runs.flatMap((run) => {
    const override = overrides[run.id];
    if (!override) return [];
    const parts = [override.model ? `model ${override.model}` : '', override.runSeconds ? `${Math.round(override.runSeconds / 60)} min run limit` : '', override.maxSteps ? `${override.maxSteps} steps` : '', override.modelAnswerSeconds ? `${override.modelAnswerSeconds} s per model answer` : ''].filter(Boolean);
    return parts.length ? [`${run.name.slice(0, 60)}: ${parts.join(', ')}`] : [];
  });
  return notes.length ? ` Retry settings: ${notes.join('; ')}.` : '';
}

export function draftRuns(mission: Mission): Mission {
  if (mission.status !== 'draft' || !mission.runs.some((run) => run.status === 'queued')) return mission;
  return { ...mission, runs: mission.runs.map((run) => run.status === 'queued' ? { ...run, status: 'draft' } : run) };
}

export class GitflareCoordinator extends DurableObject<AppEnv> {
  private store: SqlStore;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
  }

  private host(): CoordinatorHost {
    const store = () => this.store;
    return {
      ctx: this.ctx, env: this.env, get store() { return store(); },
      getMission: (id) => this.getMission(id),
      requiredMission: (id) => this.requiredMission(id),
      saveMission: (mission, message, type) => this.saveMission(mission, message, type),
      archive: (mission, reason) => this.archive(mission, reason),
      isMissionActive: (id, epoch) => this.isMissionActive(id, epoch),
      getRepository: (id) => this.getRepository(id),
      saveRepository: (repository) => this.saveRepository(repository),
      recordContributorLanding: (mission) => this.recordContributorLanding(mission),
      recordLinkedIssues: (mission, sha) => this.recordLinkedIssues(mission, sha),
      ensureDispatchAlarm: (when) => this.ensureDispatchAlarm(when),
    };
  }

  private previews() { return new PreviewBook(this.host()); }
  private dispatches() { return new DispatchBook(this.host()); }
  private integrations() { return new IntegrationBook(this.host()); }
  private capacity() { return new CapacityBook(this.host()); }

  demoImport(records: [string, unknown][]): number {
    assertDemoMode(this.env);
    this.ctx.storage.transactionSync(() => { for (const [key, value] of records) this.store.put(key, value); });
    return records.length;
  }

  async demoWipe(): Promise<void> {
    assertDemoMode(this.env);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.store = new SqlStore(this.ctx.storage.sql);
  }

  demoControl(): DemoControlState { assertDemoMode(this.env); return new DemoControlBook(this.store).state(); }
  demoClaimReset(now: number): { generation: number; previous: DemoCurrent | null } { assertDemoMode(this.env); return this.ctx.storage.transactionSync(() => new DemoControlBook(this.store).claim(now)); }
  demoFinishReset(current: DemoCurrent): number[] { assertDemoMode(this.env); return this.ctx.storage.transactionSync(() => new DemoControlBook(this.store).finish(current)); }
  demoFailReset(generation: number): void { assertDemoMode(this.env); this.ctx.storage.transactionSync(() => new DemoControlBook(this.store).fail(generation)); }
  demoCleaned(generations: number[]): void { assertDemoMode(this.env); this.ctx.storage.transactionSync(() => new DemoControlBook(this.store).cleaned(generations)); }

  async setAuthorization(id: string, authorization: NonNullable<Mission['authorization']>): Promise<void> {
    this.ctx.storage.transactionSync(() => { const mission = this.getMission(id); if (!mission) throw new ApiError(404, 'MISSION_NOT_FOUND', 'This Stream could not be found.'); if (mission.authorization) return; if (['queued', 'running', 'checking', 'integrating', 'integrated'].includes(mission.status)) throw new ApiError(409, 'AUTHORITY_LOCKED', 'An active Stream cannot change its execution authority.'); mission.authorization = authorization; this.saveMission(mission); });
  }

  private mutate<T>(key: string, fingerprint: string, operation: () => T): T {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.store.get<Receipt<T>>(`request:${key}`);
      if (receipt) {
        assertReplayFingerprint(receipt.fingerprint, fingerprint);
        return receipt.result;
      }
      const result = operation();
      this.store.put(`request:${key}`, { fingerprint, result });
      return result;
    });
  }

  private mutateMission(key: string, fingerprint: string, id: string, operation: () => Mission): Mission {
    const result = this.mutate(key, fingerprint, operation);
    const current = this.requiredMission(id);
    if (result.epoch !== current.epoch) throw new ApiError(409, 'STALE_REQUEST', 'This request belongs to an earlier attempt. Refresh before taking a new action.');
    return current;
  }

  listRepositories(): Repository[] {
    return this.store.list<Repository>('repository:');
  }

  getRepository(id: string): Repository | undefined {
    return this.store.get<Repository>(`repository:${id}`);
  }

  saveRepository(repository: Repository): void {
    this.store.put(`repository:${repository.id}`, repository);
  }

  forkStorage(): number { return this.store.get<number>('fork-storage') ?? 0; }

  notificationAudience(thread: string, add: { userId: string; reason: string }[]) { return this.ctx.storage.transactionSync(() => new SubscriptionBook(this.store).audience(thread, add)); }
  notificationSubscription(thread: string, userId: string): SubscriptionState { return new SubscriptionBook(this.store).subscription(thread, userId); }
  setNotificationSubscription(thread: string, userId: string, state: SubscriptionState): SubscriptionState { return this.ctx.storage.transactionSync(() => new SubscriptionBook(this.store).setSubscription(thread, userId, state)); }
  setRepositoryWatcher(userId: string, on: boolean): void { this.ctx.storage.transactionSync(() => new SubscriptionBook(this.store).setWatcher(userId, on)); }

  async deliverNotification(userId: string, input: { id: string; reason: NotificationReason; event: NotificationEvent; subject: NotificationSubject; actorId?: string; excerpt?: string; origin?: string }): Promise<{ stored: boolean; email: 'sent' | 'queued' | 'off' }> {
    const book = new NotificationBook(this.store);
    const { record, fresh } = this.ctx.storage.transactionSync(() => { book.claim(userId); book.rememberOrigin(input.origin); return book.deliver(input); });
    if (!fresh) return { stored: false, email: 'off' };
    if (book.emailMode(input.reason) === 'off') return { stored: true, email: 'off' };
    const entry: DigestEntry = { id: input.id, threadId: record.id, reason: input.reason, event: input.event, subject: input.subject, ...(input.actorId ? { actorId: input.actorId } : {}), ...(input.excerpt ? { excerpt: input.excerpt } : {}), at: record.updatedAt };
    if (book.emailMode(input.reason) === 'instant' && book.instantAllowed() && await sendNotificationEmail(this.env, userId, book, [entry], false) === 'sent') return { stored: true, email: 'sent' };
    await this.ensureDispatchAlarm(this.ctx.storage.transactionSync(() => book.queueDigest(entry)));
    return { stored: true, email: 'queued' };
  }

  notifications(userId: string, filter: NotificationFilter): NotificationRecord[] { const book = new NotificationBook(this.store); book.claim(userId); return book.list(filter); }
  markNotifications(userId: string, action: 'read' | 'unread' | 'archive' | 'unarchive' | 'read-all', ids: string[]): number { return this.ctx.storage.transactionSync(() => { const book = new NotificationBook(this.store); book.claim(userId); return book.mark(action, ids); }); }
  forgetNotifications(userId: string, ids: string[]): void { this.ctx.storage.transactionSync(() => { const book = new NotificationBook(this.store); book.claim(userId); book.forget(ids); }); }
  notificationPreferences(userId: string): { preferences: NotificationPreferences; nextDigestAt: string | null; sentToday: number } {
    const book = new NotificationBook(this.store); book.claim(userId);
    const due = book.digestAt();
    return { preferences: book.preferences(), nextDigestAt: due ? new Date(due).toISOString() : null, sentToday: book.sentToday() };
  }
  setNotificationPreferences(userId: string, value: unknown): NotificationPreferences { return this.ctx.storage.transactionSync(() => { const book = new NotificationBook(this.store); book.claim(userId); return book.setPreferences(value); }); }
  unsubscribeNotifications(userId: string, token: string, reason: NotificationReason | 'all'): NotificationPreferences | null { return this.ctx.storage.transactionSync(() => { const book = new NotificationBook(this.store); if (this.store.get('nf-owner') !== userId) return null; return book.unsubscribe(token, reason); }); }
  archiveInboxRows(userId: string, rows: { id: string; version: string }[], archived: boolean): void { this.ctx.storage.transactionSync(() => { const book = new NotificationBook(this.store); book.claim(userId); book.inboxArchive(rows, archived); }); }
  inboxArchived(userId: string): Record<string, string> { const book = new NotificationBook(this.store); book.claim(userId); return book.inboxArchived(); }

  private async deliverNotificationDigest(): Promise<void> {
    const userId = this.store.get<string>('nf-owner');
    if (!userId) return;
    const book = new NotificationBook(this.store);
    const entries = this.ctx.storage.transactionSync(() => book.takeDigest())?.filter(entry => book.emailMode(entry.reason) !== 'off');
    if (!entries?.length) return;
    if (!book.dailyAllowed()) { this.ctx.storage.transactionSync(() => book.postponeDigest(entries)); return; }
    try { await sendNotificationEmail(this.env, userId, book, entries, true); }
    catch (error) { this.ctx.storage.transactionSync(() => book.postponeDigest(entries)); throw error; }
  }

  setReviewRequests(missionId: string, requests: ReviewRequests): Mission | undefined {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.getMission(missionId);
      if (!mission || mission.epoch !== requests.epoch || mission.candidateSha !== requests.candidateSha || mission.baseSha !== requests.baseSha) return undefined;
      if (JSON.stringify(mission.reviewRequests) === JSON.stringify(requests)) return mission;
      mission.reviewRequests = requests;
      const owners = [...new Set(requests.groups.flatMap(group => group.handles))];
      return this.saveMission(mission, owners.length ? `Review requested from code owners: ${owners.slice(0, 10).map(handle => `@${handle}`).join(', ')}.` : undefined);
    });
  }

  addForkStorage(bytes: number): number {
    return this.ctx.storage.transactionSync(() => {
      const total = this.forkStorage() + Math.max(0, Math.floor(bytes));
      this.store.put('fork-storage', total);
      return total;
    });
  }

  recordFork(entry: { workspaceId: string; repositoryId: string; forkedAt: string }): void { this.store.put(`forked-into:${entry.repositoryId}`, entry); }

  forkCount(): number { return this.store.list('forked-into:').length; }

  listSummaryCache(): MissionSummaryCache[] {
    return this.store.list<MissionSummaryCache>('summary-cache:');
  }

  saveSummaryCache(entries: MissionSummaryCache[]): void {
    this.ctx.storage.transactionSync(() => { for (const entry of entries) this.store.put(`summary-cache:${entry.repositoryId}`, entry); });
  }

  listIssues(query: IssueQuery): IssueList { return listIssues(this.store, query); }

  getIssue(number: number): IssueDetail | undefined { return readIssue(this.store, number); }

  changeIssue(key: string, change: IssueChange, actor: IssueActor): IssueDetail { return readIssue(this.store, this.mutate(key, issueFingerprint(change, actor), () => applyIssueChange(this.store, change, actor)))!; }

  issueLabels(): IssueLabelDefinition[] { return listLabelDefinitions(this.store); }

  changeIssueLabels(key: string, change: IssueLabelChange): IssueLabelDefinition[] { this.mutate(key, JSON.stringify(['issue-label', change]), () => applyLabelChange(this.store, change).length); return listLabelDefinitions(this.store); }
  getBranchRequest(key: string, fingerprint: string): BranchChangeResult | undefined {
    const receipt = this.store.get<Receipt<BranchChangeResult>>(`branch-request:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt?.result;
  }

  recordBranchRequest(key: string, fingerprint: string, result: BranchChangeResult): BranchChangeResult {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.store.get<Receipt<BranchChangeResult>>(`branch-request:${key}`);
      if (receipt) { assertReplayFingerprint(receipt.fingerprint, fingerprint); return receipt.result; }
      this.store.put(`branch-request:${key}`, { fingerprint, result });
      return result;
    });
  }

  getCheckSettings(): CheckSettings | undefined { return this.store.get<CheckSettings>('check-settings'); }

  getAgentSettings(): AgentSettings | undefined { return this.store.get<AgentSettings>('agent-settings'); }

  setAgentSettings(key: string, input: AgentSettings, actorId: string): AgentSettings {
    const normalized = normalizeAgentSettings({ ...input });
    return this.mutate(key, JSON.stringify(['agent-settings', normalized]), () => {
      const stored: AgentSettings = { ...normalized, updatedAt: new Date().toISOString(), updatedBy: actorId };
      this.store.put('agent-settings', stored);
      return stored;
    });
  }

  private pinAgentLimits(run: AgentRun): Pick<AgentRun, 'editScope' | 'overrides' | 'limits'> {
    return { ...(run.editScope ? { editScope: [...run.editScope] } : {}), ...(run.overrides ? { overrides: { ...run.overrides } } : {}), limits: effectiveAgentLimits(this.getAgentSettings(), run.overrides) };
  }

  getCheckDurations(): number[] { return this.store.get<number[]>('check-durations') ?? []; }

  getCheckPlan(missionId?: string): CheckPlan {
    const plan = checkPlan(this.getCheckSettings(), this.getCheckDurations());
    const override = missionId ? this.store.get<CheckOverride>(`check-override:${missionId}`) : undefined;
    return override ? { ...plan, override } : plan;
  }

  setCheckOverride(key: string, missionId: string, input: Pick<CheckOverride, 'testTimeoutSeconds' | 'runner'>, actorId: string): CheckOverride {
    this.requiredMission(missionId);
    return this.mutate(key, JSON.stringify(['check-override', missionId, input]), () => {
      const previous = this.store.get<CheckOverride>(`check-override:${missionId}`);
      const stored: CheckOverride = { ...(previous?.testTimeoutSeconds !== undefined ? { testTimeoutSeconds: previous.testTimeoutSeconds } : {}), ...(previous?.runner ? { runner: previous.runner } : {}), ...input, actorId, at: new Date().toISOString() };
      this.store.put(`check-override:${missionId}`, stored);
      return stored;
    });
  }

  applyLearnedCheckLimits(id: string, epoch: number, learned: LearnedLimits): CheckSettings | null {
    return this.ctx.storage.transactionSync(() => {
      const fence = `learned-limits:${id}-${epoch}`;
      if (this.store.get(fence)) return null;
      this.store.put(fence, { at: new Date().toISOString() });
      const next = withLearnedLimits(this.getCheckSettings(), learned);
      if (!next) return null;
      const stored: CheckSettings = { ...normalizeCheckSettings({ ...next }), updatedAt: new Date().toISOString(), updatedBy: AUTO_INCREASE_ACTOR };
      this.store.put('check-settings', stored);
      return stored;
    });
  }

  getPreviewSettings(): PreviewSettings { return storedPreviewSettings(this.store.get<PreviewSettings>('preview-settings')); }

  setPreviewSettings(key: string, settings: Omit<PreviewSettings, 'updatedAt' | 'updatedBy'>, actorId: string): PreviewSettings {
    return this.mutate(key, JSON.stringify(['preview-settings', settings]), () => {
      const stored: PreviewSettings = { ...settings, updatedAt: new Date().toISOString(), updatedBy: actorId };
      this.store.put('preview-settings', stored);
      return stored;
    });
  }

  setCheckSettings(key: string, input: CheckSettingsInput, actorId: string): CheckSettings {
    const normalized = normalizeCheckSettings({ ...input });
    return this.mutate(key, JSON.stringify(['check-settings', normalized]), () => {
      const stored: CheckSettings = { ...normalized, updatedAt: new Date().toISOString(), updatedBy: actorId };
      this.store.put('check-settings', stored);
      return stored;
    });
  }

  getBranchProtection(): StoredBranchProtection | undefined { return this.store.get<StoredBranchProtection>('branch-protection'); }

  setBranchProtection(key: string, rules: unknown, actorId: string): StoredBranchProtection {
    const normalized = normalizeBranchRules(rules);
    return this.mutate(key, JSON.stringify(['branch-protection', normalized]), () => {
      const stored = { rules: normalized, updatedAt: new Date().toISOString(), updatedBy: actorId } satisfies StoredBranchProtection;
      this.store.put('branch-protection', stored);
      return stored;
    });
  }

  pullRequestAction(key: string, id: string, action: 'update' | 'close' | 'reopen', actorId: string, headSha?: string, clearFor?: Principal): Mission {
    return this.mutateMission(key, JSON.stringify(['pull', id, action, headSha ?? null]), id, () => {
      const mission = this.requiredMission(id);
      this.queueApprovalClear(id, clearFor);
      const change = mission.branchChange;
      if (!change) throw new ApiError(409, 'NOT_A_PULL_REQUEST', 'Only a pull request can be updated from its branch, closed or reopened.');
      if (['integrating', 'integrated'].includes(mission.status)) throw new ApiError(409, 'PULL_REQUEST_LANDED', 'This pull request is landing or has landed.');
      if (action === 'close') {
        if (change.closedAt) return mission;
        if (mission.status === 'approved') { this.archive(mission, 'approved'); delete mission.approvedAt; delete mission.approvedBy; delete mission.dependencyApproval; this.archive(mission, 'approval_revoked'); }
        this.store.delete(`dispatch:${mission.id}-${mission.epoch}`);
        this.store.delete(`watch:${mission.id}-${mission.epoch}`);
        mission.runs = mission.runs.map((run) => ['queued', 'running'].includes(run.status) ? { ...run, status: 'cancelled', completedAt: new Date().toISOString() } : run);
        mission.status = 'cancelled';
        mission.branchChange = { ...change, closedAt: new Date().toISOString(), closedBy: actorId };
        this.saveMission(mission, `${actorId} closed this pull request. Late execution results will be rejected.`, 'warning');
        this.archive(mission, 'cancelled');
        return mission;
      }
      if (!headSha || !validGitSha(headSha)) throw new ApiError(400, 'INVALID_COMMIT', 'Provide the exact branch head commit.');
      if (action === 'reopen' && !change.closedAt) throw new ApiError(409, 'PULL_REQUEST_OPEN', 'This pull request is already open.');
      if (action === 'update' && change.closedAt) throw new ApiError(409, 'PULL_REQUEST_CLOSED', 'Reopen this pull request before updating it from its branch.');
      if (['queued', 'running', 'checking'].includes(mission.status)) throw new ApiError(409, 'MISSION_ACTIVE', 'Checks are already running for this pull request. Wait or cancel them first.');
      if (mission.status === 'approved') {
        this.archive(mission, 'approved');
        mission.status = 'needs_review';
        delete mission.approvedAt;
        delete mission.approvedBy;
        delete mission.dependencyApproval;
        this.archive(mission, 'approval_revoked');
      }
      const { closedAt: _closedAt, closedBy: _closedBy, ...open } = change;
      mission.branchChange = { ...open, headSha };
      mission.runs = mission.runs.map((run) => run.name === BRANCH_MERGER.name ? retaskBranchMerger(run, mission.branchChange!) : run);
      return this.saveMission(mission, action === 'reopen' ? `${actorId} reopened this pull request at ${headSha.slice(0, 12)}.` : `${actorId} updated this pull request from ${change.branch} at ${headSha.slice(0, 12)}. Earlier approvals no longer apply.`);
    });
  }

  getModelConnections(): ModelConnection[] { return this.store.get<ModelConnection[]>('model-connections') ?? defaultModelConnections(); }

  getDefaultModel(): string | null { return this.store.get<string>('default-model') ?? null; }

  setDefaultModel(id: string): ModelConnection[] {
    const models = this.getModelConnections();
    if (!models.some(model => model.id === id)) throw new ApiError(404, 'MODEL_NOT_FOUND', 'This model is not enabled. Enable it before making it the default.');
    this.store.put('default-model', id);
    return models;
  }

  getAiCredentials(): AiCredentials { return { keys: this.store.get<StoredAiKey[]>('ai-keys') ?? [], gateway: this.store.get<StoredAiGateway>('ai-gateway') ?? null, operatorModels: this.store.get<OperatorModelGrant>('operator-models') ?? null }; }

  setOperatorModels(grant: OperatorModelGrant | null): AiCredentials {
    if (grant) this.store.put('operator-models', grant);
    else this.store.delete('operator-models');
    return this.getAiCredentials();
  }

  reserveOperatorUsage(kind: OperatorUsageKind, id: string, now = Date.now()): { allowed: boolean; limit: number } {
    return this.ctx.storage.transactionSync(() => {
      const grant = this.store.get<OperatorModelGrant>('operator-models');
      if (!grant) return { allowed: true, limit: 0 };
      const limit = kind === 'mission' ? grant.missionsPerDay : grant.draftsPerDay;
      const day = new Date(now).toISOString().slice(0, 10);
      const yesterday = new Date(now - 86_400_000).toISOString().slice(0, 10);
      this.store.delete(`operator-usage:${kind}:${yesterday}`);
      const used = this.store.get<string[]>(`operator-usage:${kind}:${day}`) ?? [];
      if (used.includes(id)) return { allowed: true, limit };
      if (used.length >= limit) return { allowed: false, limit };
      this.store.put(`operator-usage:${kind}:${day}`, [...used, id]);
      return { allowed: true, limit };
    });
  }

  saveAiKey(record: StoredAiKey): AiCredentials {
    return this.ctx.storage.transactionSync(() => {
      this.store.put('ai-keys', [...this.getAiCredentials().keys.filter(key => key.provider !== record.provider), record]);
      return this.getAiCredentials();
    });
  }

  removeAiKey(provider: string): AiCredentials {
    return this.ctx.storage.transactionSync(() => {
      const keys = this.getAiCredentials().keys;
      if (!keys.some(key => key.provider === provider)) throw new ApiError(404, 'AI_KEY_NOT_FOUND', 'No key is stored for this provider.');
      this.store.put('ai-keys', keys.filter(key => key.provider !== provider));
      return this.getAiCredentials();
    });
  }

  saveAiGateway(record: StoredAiGateway | null): AiCredentials {
    if (record) this.store.put('ai-gateway', record);
    else this.store.delete('ai-gateway');
    return this.getAiCredentials();
  }

  communityPool(): CommunityPool | null { return publicPool(readPool(this.store)); }

  storedCommunityPool(): StoredPool | null { return readPool(this.store); }

  setCommunityPool(pool: StoredPool | null): CommunityPool | null { writePool(this.store, pool); return publicPool(pool); }

  agentAssist(): AgentAssistSettings { return readAssist(this.store); }

  setAgentAssist(settings: AgentAssistSettings): AgentAssistSettings { return writeAssist(this.store, settings); }

  communityPoolUsage(now = Date.now()): CommunityPoolUsage { return poolUsage(this.store, now); }

  communityPoolRemaining(userId: string, now = Date.now()): number | null { const pool = readPool(this.store); return pool ? requesterRemaining(this.store, pool, userId, now) : null; }

  reserveCommunityPool(kind: PoolKind, id: string, userId: string | null, now = Date.now()): { allowed: boolean; reason: string } {
    return this.ctx.storage.transactionSync(() => reservePool(this.store, kind, id, userId, now));
  }

  reserveOperatorTriage(id: string, limit: number, now = Date.now()): boolean {
    return this.ctx.storage.transactionSync(() => {
      const day = new Date(now).toISOString().slice(0, 10);
      this.store.delete(`operator-triage:${new Date(now - 86_400_000).toISOString().slice(0, 10)}`);
      const used = this.store.get<string[]>(`operator-triage:${day}`) ?? [];
      if (used.includes(id)) return true;
      if (used.length >= limit) return false;
      this.store.put(`operator-triage:${day}`, [...used, id]);
      return true;
    });
  }

  recordOperatorAi(entry: OperatorAiUse): void {
    this.ctx.storage.transactionSync(() => this.store.put('operator-ai-log', [entry, ...(this.store.get<OperatorAiUse[]>('operator-ai-log') ?? [])].slice(0, 200)));
  }

  operatorAiLog(): OperatorAiUse[] { return this.store.get<OperatorAiUse[]>('operator-ai-log') ?? []; }

  triageSuggestion(number: number): TriageSuggestion | null { return this.store.get<TriageSuggestion>(`triage:${number}`) ?? null; }

  saveTriageSuggestion(suggestion: TriageSuggestion): TriageSuggestion {
    if (!readIssue(this.store, suggestion.issueNumber)) throw new ApiError(404, 'ISSUE_NOT_FOUND', 'This issue could not be found.');
    this.store.put(`triage:${suggestion.issueNumber}`, suggestion);
    return suggestion;
  }

  dismissTriageSuggestion(number: number): void { this.store.delete(`triage:${number}`); }

  acceptTriageSuggestion(key: string, number: number, body: string): IssueDetail {
    this.mutate(key, JSON.stringify(['triage-accept', number]), () => {
      const suggestion = this.store.get<TriageSuggestion>(`triage:${number}`);
      if (!suggestion) throw new ApiError(404, 'TRIAGE_NOT_FOUND', 'This issue has no triage suggestion.');
      applyTriage(this.store, number, suggestion.labels, body);
      this.store.delete(`triage:${number}`);
      return number;
    });
    return readIssue(this.store, number)!;
  }

  missionForRequest(key: string): Mission | undefined {
    const result = this.store.get<Receipt<{ id?: unknown }>>(`request:${key}`)?.result;
    return result && typeof result.id === 'string' ? this.getMission(result.id) : undefined;
  }

  holdFixRequest(id: string): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      if (!mission.fixRequest || mission.status !== 'draft') return mission;
      mission.fixRequest = { ...mission.fixRequest, waiting: true };
      return this.saveMission(mission, 'Waiting for a maintainer to start the agents.');
    });
  }

  addAgentReview(id: string, epoch: number, candidateSha: string, baseSha: string, body: string): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      if (mission.epoch !== epoch || mission.candidateSha !== candidateSha || mission.baseSha !== baseSha) throw new ApiError(409, 'STALE_REVIEW', 'The candidate changed while the agent reviewed it.');
      if (mission.status !== 'needs_review') throw new ApiError(409, 'REVIEW_LOCKED', 'Only a candidate awaiting review can receive an agent review.');
      mission.reviews ??= [];
      if (mission.reviews.some(review => review.authorId === AGENT_REVIEWER_ID && review.candidateSha === candidateSha && review.epoch === epoch)) throw new ApiError(409, 'AGENT_REVIEW_EXISTS', 'The agent already reviewed this candidate.');
      if (mission.reviews.length >= 500) throw new ApiError(409, 'REVIEW_LIMIT', 'This proposal has reached its discussion limit.');
      mission.reviews.push({ id: crypto.randomUUID(), kind: 'comment', body, authorId: AGENT_REVIEWER_ID, createdAt: new Date().toISOString(), epoch, candidateSha, baseSha });
      return this.saveMission(mission, 'The review agent added a comment. Agent reviews never approve.');
    });
  }

  getAiEnabled(): boolean { return this.store.get<boolean>('ai-enabled') ?? true; }

  setAiEnabled(enabled: boolean): boolean { this.store.put('ai-enabled', enabled); return enabled; }

  getModelRequest(key: string, fingerprint: string): { result?: ModelConnection[] } | undefined {
    const receipt = this.store.get<Receipt<ModelConnection[] | undefined>>(`model-request:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt ? { result: receipt.result } : undefined;
  }

  claimModelVerification(key: string, fingerprint: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.getModelRequest(key, fingerprint)) return false;
      this.store.put(`model-request:${key}`, { fingerprint });
      return true;
    });
  }

  changeModelConnections(key: string, fingerprint: string, action: 'add' | 'remove', value: ModelConnection | string): ModelConnection[] {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getModelRequest(key, fingerprint);
      if (receipt?.result) return receipt.result;
      if (receipt) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'This model request is pending verification.');
      const models = this.getModelConnections();
      let updated: ModelConnection[];
      if (action === 'add') {
        const model = validateModelConnection(value);
        if (models.some(existing => existing.id === model.id)) throw new ApiError(409, 'MODEL_ALREADY_CONFIGURED', 'This model is already enabled. Remove it before changing its transport.');
        if (models.length >= 20) throw new ApiError(400, 'MODEL_LIMIT', 'Enable at most 20 models in a workspace.');
        updated = [...models, model];
      } else {
        if (!models.some(model => model.id === value)) throw new ApiError(404, 'MODEL_NOT_FOUND', 'This model is not enabled.');
        updated = models.filter(model => model.id !== value);
        if (this.getDefaultModel() === value) this.store.delete('default-model');
      }
      this.store.put('model-connections', updated);
      this.store.put(`model-request:${key}`, { fingerprint, result: updated });
      return updated;
    });
  }

  completeModelVerification(key: string, fingerprint: string, verified: ModelConnection): ModelConnection[] {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getModelRequest(key, fingerprint);
      if (!receipt) throw new ApiError(409, 'MODEL_REQUEST_PENDING', 'Model verification has no active request.');
      if (receipt.result) return receipt.result;
      const models = this.getModelConnections();
      const current = models.find(model => model.id === verified.id);
      if (!current || current.source !== verified.source || current.protocol !== verified.protocol) throw new ApiError(409, 'MODEL_CONNECTION_CHANGED', 'The model connection changed while verification was running.');
      const updated = models.map(model => model.id === verified.id ? { ...model, verification: verified.verification } : model);
      this.store.put('model-connections', updated);
      this.store.put(`model-request:${key}`, { fingerprint, result: updated });
      return updated;
    });
  }

  repositoryBootstrapSha(): string | undefined { return this.store.get<string>('repository-bootstrap'); }

  saveRepositoryBootstrapSha(sha: string): void { this.store.put('repository-bootstrap', sha); }

  listReleases(): Release[] { return this.store.list<Release>('release:'); }

  getRelease(id: string): Release | undefined { return this.store.get<Release>(`release:${id}`); }

  getReleaseRequest(key: string, fingerprint: string): ReleaseReceipt | undefined {
    const receipt = this.store.get<ReleaseReceipt>(`release-request:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt;
  }

  changeRelease(key: string, fingerprint: string, change: ReleaseChange): { receipt: ReleaseReceipt; fresh: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const reserved = new Map(this.store.list<{ tag: string; key: string }>('release-pending:').map(item => [item.tag, item.key]));
      const outcome = applyReleaseChange(this.listReleases(), reserved, this.getReleaseRequest(key, fingerprint), key, fingerprint, change);
      if (!outcome.fresh) return { receipt: outcome.receipt, fresh: false };
      if (outcome.put) this.store.put(`release:${outcome.put.id}`, outcome.put);
      if (outcome.remove) this.store.delete(`release:${outcome.remove}`);
      if (outcome.reserve) this.store.put(`release-pending:${outcome.reserve}`, { tag: outcome.reserve, key });
      if (outcome.unreserve) this.store.delete(`release-pending:${outcome.unreserve}`);
      this.store.put(`release-request:${key}`, outcome.receipt);
      return { receipt: outcome.receipt, fresh: true };
    });
  }

  listReleaseAssets(releaseId?: string): StoredAsset[] { return listAssets(this.store, releaseId); }

  releaseAssetUsage(): number { return assetUsage(this.store); }

  commitReleaseAsset(key: string, asset: StoredAsset): StoredAsset { return this.mutate(key, JSON.stringify(['release-asset', asset.id, asset.releaseId, asset.name, asset.size, asset.sha256]), () => commitAsset(this.store, asset)); }

  removeReleaseAsset(key: string, releaseId: string, assetId: string): StoredAsset { return this.mutate(key, JSON.stringify(['release-asset-delete', releaseId, assetId]), () => removeAsset(this.store, releaseId, assetId)); }

  removeReleaseAssets(releaseId: string): StoredAsset[] { return this.ctx.storage.transactionSync(() => this.store.get(`release:${releaseId}`) ? [] : removeReleaseAssets(this.store, releaseId)); }

  chargeAssetDownload(bytes: number): boolean { return this.ctx.storage.transactionSync(() => chargeDownload(this.store, bytes)); }

  listAdvisories(): Advisory[] { return listAdvisories(this.store); }

  getAdvisory(id: string): Advisory | undefined { return this.store.get<Advisory>(`advisory:${id}`); }

  changeAdvisory(key: string, change: AdvisoryChange): Advisory { return this.mutate(key, advisoryFingerprint(change), () => applyAdvisoryChange(this.store, change)); }

  getImportRequest(key: string, fingerprint: string): ImportReceipt | undefined {
    const receipt = this.store.get<ImportReceipt>(`repository-import:${key}`);
    if (receipt) assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt;
  }

  claimRepositoryImport(key: string, fingerprint: string): { claimed: boolean; receipt: ImportReceipt } {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (receipt) return { claimed: false, receipt };
      if (this.store.get<string>('repository-import-active')) throw new ApiError(409, 'IMPORT_PENDING', 'A repository import is pending reconciliation. Retry its original request before importing again.');
      const next = { fingerprint, timestamp: Math.floor(Date.now() / 1000) } satisfies ImportReceipt;
      this.store.put(`repository-import:${key}`, next);
      this.store.put('repository-import-active', key);
      return { claimed: true, receipt: next };
    });
  }

  prepareRepositoryImport(key: string, fingerprint: string, candidateSha: string, files: string[], skipped: string[], details: Pick<ImportReceipt, 'exclusions' | 'warnings' | 'install'> = {}): void {
    this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (!receipt || this.store.get<string>('repository-import-active') !== key || receipt.candidateSha) throw new ApiError(409, 'IMPORT_PENDING', 'This import has already been prepared or is no longer active.');
      this.store.put(`repository-import:${key}`, { ...receipt, candidateSha, files, skipped, ...details } satisfies ImportReceipt);
    });
  }

  rejectRepositoryImport(key: string, fingerprint: string, rejection: NonNullable<ImportReceipt['rejection']>): void {
    this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (!receipt || receipt.result || this.store.get<string>('repository-import-active') !== key) throw new ApiError(409, 'IMPORT_PENDING', 'The import is not active.');
      this.store.put(`repository-import:${key}`, { ...receipt, rejection } satisfies ImportReceipt);
      this.store.delete('repository-import-active');
    });
  }

  completeRepositoryImport(key: string, fingerprint: string, repository: Repository): ImportResult {
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.getImportRequest(key, fingerprint);
      if (!receipt?.candidateSha || repository.headSha !== receipt.candidateSha) throw new ApiError(409, 'IMPORT_UNCONFIRMED', 'The canonical import commit has not been confirmed.');
      if (receipt.result) return receipt.result;
      if (this.store.get<string>('repository-import-active') !== key) throw new ApiError(409, 'IMPORT_PENDING', 'This import is no longer active.');
      const result = { repository, headSha: receipt.candidateSha, files: receipt.files ?? [], skipped: receipt.skipped ?? [], ...(receipt.exclusions ? { exclusions: receipt.exclusions } : {}), ...(receipt.warnings ? { warnings: receipt.warnings } : {}), ...(receipt.install !== undefined ? { install: receipt.install } : {}) } satisfies ImportResult;
      this.saveRepository(repository);
      this.store.put(`repository-import:${key}`, { ...receipt, result } satisfies ImportReceipt);
      this.store.delete('repository-import-active');
      return result;
    });
  }

  claimProvision(id: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      if (this.store.get<boolean>(`provision:${id}`)) return false;
      this.store.put(`provision:${id}`, true);
      return true;
    });
  }

  savePreviewCapability(...args: Parameters<PreviewBook['savePreviewCapability']>) { return this.previews().savePreviewCapability(...args); }

  getPreviewCapability(...args: Parameters<PreviewBook['getPreviewCapability']>) { return this.previews().getPreviewCapability(...args); }

  private prunePreviewCapabilities(...args: Parameters<PreviewBook['prunePreviewCapabilities']>) { return this.previews().prunePreviewCapabilities(...args); }

  claimPreview(...args: Parameters<PreviewBook['claimPreview']>) { return this.previews().claimPreview(...args); }

  renewPreview(...args: Parameters<PreviewBook['renewPreview']>) { return this.previews().renewPreview(...args); }

  previewStep(...args: Parameters<PreviewBook['previewStep']>) { return this.previews().previewStep(...args); }

  previewReady(...args: Parameters<PreviewBook['previewReady']>) { return this.previews().previewReady(...args); }

  workerPreviewReady(...args: Parameters<PreviewBook['workerPreviewReady']>) { return this.previews().workerPreviewReady(...args); }

  extendPreview(...args: Parameters<PreviewBook['extendPreview']>) { return this.previews().extendPreview(...args); }

  workerPreview(...args: Parameters<PreviewBook['workerPreview']>) { return this.previews().workerPreview(...args); }

  retireWorkerPreview(...args: Parameters<PreviewBook['retireWorkerPreview']>) { return this.previews().retireWorkerPreview(...args); }

  stopPreview(...args: Parameters<PreviewBook['stopPreview']>) { return this.previews().stopPreview(...args); }

  previewFailed(...args: Parameters<PreviewBook['previewFailed']>) { return this.previews().previewFailed(...args); }

  previewStatus(...args: Parameters<PreviewBook['previewStatus']>) { return this.previews().previewStatus(...args); }

  candidatePreviewKeys(...args: Parameters<PreviewBook['candidatePreviewKeys']>) { return this.previews().candidatePreviewKeys(...args); }

  createRepository(key: string, repository: Repository): Repository {
    return this.mutate(key, JSON.stringify(['repository', repository.name, repository.description]), () => {
      const label = repositoryLabel(repository).toLowerCase();
      if (this.listRepositories().some((item) => item.name.toLowerCase() === repository.name.toLowerCase() || repositoryLabel(item).toLowerCase() === label)) {
        throw new ApiError(409, 'REPOSITORY_EXISTS', `A repository named ${repositoryLabel(repository)} already exists in this workspace.`);
      }
      this.saveRepository(repository);
      return repository;
    });
  }

  connectRepository(key: string, repository: Repository): Repository {
    return this.mutate(key, JSON.stringify(['connect', repository.name, repository.description, repository.remote]), () => {
      const existing = this.listRepositories().find((item) => item.name.toLowerCase() === repository.name.toLowerCase());
      if (existing?.remote && existing.remote !== repository.remote) throw new ApiError(409, 'REMOTE_MISMATCH', 'This repository is connected to a different remote.');
      const connected = existing ? { ...repository, id: existing.id, createdAt: existing.createdAt } : repository;
      this.saveRepository(connected);
      return connected;
    });
  }

  private readonly blobs: BlobStore = { get: (key) => this.store.get<string>(key), putIfAbsent: (key, value) => this.store.putIfAbsent(key, value) };

  listMissions(): Mission[] {
    return this.store.list<Mission>('mission:').map((mission) => draftRuns(unpackMission(mission, this.blobs))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listMissionSummaries(): MissionSummary[] {
    return this.store.list<Mission>('mission:').map((mission) => summarizeMission(draftRuns(mission))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMission(id: string): Mission | undefined {
    const stored = this.store.get<Mission>(`mission:${id}`);
    if (!stored) return undefined;
    const mission = unpackMission(stored, this.blobs);
    if (needsPacking(stored)) this.store.put(`mission:${id}`, packMission(mission, this.blobs));
    return draftRuns(mission);
  }

  recordMissionEvent(id: string, message: string): void {
    const mission = this.getMission(id);
    if (mission) this.saveMission(mission, message);
  }

  missionCandidate(commitSha: string): { missionId: string; forkName?: string } | undefined {
    for (const mission of this.store.list<Mission>('mission:')) {
      if (mission.candidateSha === commitSha) return { missionId: mission.id, ...(mission.integrationForkName ? { forkName: mission.integrationForkName } : {}) };
      const run = mission.runs.find((item) => item.commitSha === commitSha);
      if (run) return { missionId: mission.id, ...(run.forkName ? { forkName: run.forkName } : {}) };
    }
    return undefined;
  }

  missionCandidateShas(prefix: string): string[] {
    if (!/^[a-f0-9]{7,40}$/.test(prefix)) return [];
    const matches = new Set<string>();
    for (const mission of this.store.list<Mission>('mission:')) {
      for (const sha of [mission.candidateSha, ...mission.runs.map((run) => run.commitSha)]) if (sha?.startsWith(prefix)) matches.add(sha);
      if (matches.size > 5) break;
    }
    return [...matches];
  }

  missionRepository(id: string): string | undefined { return this.store.get<string>(`mission-repository:${id}`); }

  indexMission(id: string, repositoryId: string): void { this.store.put(`mission-repository:${id}`, repositoryId); }

  listAttempts(id: string): MissionAttempt[] {
    this.requiredMission(id);
    return this.store.list<MissionAttempt>(`attempt:${id}:`).map((attempt) => {
      const snapshot = unpackMission(attempt.snapshot, this.blobs);
      if (needsPacking(attempt.snapshot)) this.store.put(`attempt:${id}:${attempt.id}`, { ...attempt, snapshot: packMission(snapshot, this.blobs) });
      return { ...attempt, snapshot };
    }).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  }

  private archive(mission: Mission, reason: MissionAttempt['reason']): void {
    const id = crypto.randomUUID();
    this.store.insert(`attempt:${mission.id}:${id}`, { id, epoch: mission.epoch, recordedAt: new Date().toISOString(), reason, snapshot: packMission(mission, this.blobs) } satisfies MissionAttempt);
  }

  private requiredMission(id: string): Mission {
    const mission = this.getMission(id);
    if (!mission) throw new ApiError(404, 'MISSION_NOT_FOUND', 'This mission could not be found.');
    return mission;
  }

  private saveMission(mission: Mission, message?: string, type: MissionEvent['type'] = 'info'): Mission {
    mission.updatedAt = new Date().toISOString();
    if (message) mission.events.push({ id: crypto.randomUUID(), timestamp: mission.updatedAt, type, message });
    mission.events = mission.events.slice(-200);
    this.store.put(`mission:${mission.id}`, packMission(mission, this.blobs));
    return mission;
  }

  createMission(key: string, input: CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections(), defaultModel?: string): Mission {
    return this.mutate(key, JSON.stringify(['mission', input]), () => this.newMission(input, authorization, models, undefined, defaultModel));
  }

  private newMission(input: CreateMissionInput, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections(), id: string = crypto.randomUUID(), defaultModel?: string): Mission {
      const repository = this.getRepository(input.repositoryId);
      if (!repository) throw new ApiError(404, 'REPOSITORY_NOT_FOUND', 'This repository could not be found.');
      if (input.expectedBaseSha !== undefined && input.expectedBaseSha !== repository.headSha) throw new ApiError(409, 'STALE_PROPOSAL_BASE', 'The repository changed while you drafted this proposal. Refresh the base and review your assignments before saving.');
      const now = new Date().toISOString();
      const criteria = input.acceptanceCriteria ?? [];
      const skillChange = input.skillChange ? validateRepositorySkillChange(input.skillChange) : undefined;
      if (skillChange && repository.headSha !== skillChange.baseSha) throw new ApiError(409, 'STALE_SKILL_BASE', 'The repository changed. Refresh the skill before proposing this edit.');
      const revertChange = input.revertChange;
      if (revertChange && (!validGitSha(revertChange.landedSha) || !validGitSha(revertChange.previousSha))) throw new ApiError(400, 'INVALID_COMMIT', 'A revert needs the exact landed and previous commits.');
      if (input.issueNumber !== undefined && !readIssue(this.store, input.issueNumber)) throw new ApiError(404, 'ISSUE_NOT_FOUND', `Issue #${input.issueNumber} could not be found in this repository.`);
      const branchChange = input.branchChange ? { ...input.branchChange, branch: branchName(input.branchChange.branch), targetBranch: repository.defaultBranch } : undefined;
      if (branchChange && (!validGitSha(branchChange.headSha) || (!branchChange.source && branchChange.branch === repository.defaultBranch))) throw new ApiError(400, 'INVALID_PULL_REQUEST', 'A pull request needs the exact head commit of a branch other than the default branch.');
      const race = input.mode === 'race' && !revertChange && !branchChange;
      const tasks = skillChange ? [{ name: 'Skill editor', role: 'Trusted skill editor', task: `Apply exactly the submitted Markdown to ${skillChange.path}.` }] : branchChange ? [{ ...BRANCH_MERGER, task: branchMergerTask(branchChange) }] : revertChange ? [{ name: 'Revert editor', role: 'Trusted revert editor', task: `Undo exactly the change landed by "${revertChange.title}" (${revertChange.previousSha.slice(0, 12)} to ${revertChange.landedSha.slice(0, 12)}) with a new revert commit.` }] : input.tasks ?? (race ? [
        { name: 'Candidate A', role: 'Independent attempt', task: 'Complete the whole mission with the smallest change that satisfies every criterion.' },
        { name: 'Candidate B', role: 'Independent attempt', task: 'Complete the whole mission, favouring clarity and explicit error handling.' },
      ] : [
        { name: 'Implementation agent', role: 'Implementation', task: 'Implement the core change. If this mission assigns explicit agent roles, implement only your assigned role.' },
        { name: 'Compatibility agent', role: 'Compatibility', task: 'Improve compatibility and error handling. If this mission assigns explicit agent roles, implement only your assigned role.' },
      ]);
      const mission: Mission = {
        id, repositoryId: repository.id, title: input.title, prompt: input.prompt,
        acceptanceCriteria: criteria, authorization, ...(input.attachments?.length ? { attachments: input.attachments.map(({ name, content }) => ({ name, content })) } : {}), ...(skillChange ? { skillChange } : {}), ...(revertChange ? { revertChange: { ...revertChange } } : {}), ...(branchChange ? { branchChange } : {}), ...(input.fixRequest ? { fixRequest: { ...input.fixRequest } } : {}), ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}), ...(race ? { mode: 'race' as const } : {}),
        status: 'draft', baseSha: repository.headSha, candidateSha: null, epoch: 0,
        runs: tasks.map((task) => ({ ...(skillChange || branchChange || revertChange ? {} : agentDefaults(input.agentOverrides)), ...task, assignment: task.task, id: crypto.randomUUID(), task: `${input.prompt}\nYou are ${task.name} (${task.role}). ${race ? 'Complete the whole mission on your own; other agents are attempting it independently and a reviewer will choose one result. Your approach' : 'Your assigned task'}: ${task.task}\nPreserve existing tests and run them.${criteria.length ? `\nAcceptance criteria:\n${criteria.map((criterion) => `- ${criterion}`).join('\n')}` : ''}`, status: 'draft', changedFiles: [] })),
        checks: [], changes: [], events: [], createdAt: now, updatedAt: now,
      };
      if (mission.issueNumber !== undefined) linkIssueMission(this.store, mission.issueNumber, mission.id, now);
      return this.saveMission(pinMissionModels(mission, models, defaultModel), `Mission created${mission.issueNumber !== undefined ? ` for issue #${mission.issueNumber}` : ''}. Agent execution has not started.`);
  }

  getSkillEditRequest(key: string, repositoryId: string, supplied: RepositorySkillChange): Mission | undefined {
    const change = validateRepositorySkillChange(supplied);
    const receipt = this.store.get<Receipt<Mission>>(`request:${key}`);
    if (!receipt) return undefined;
    assertReplayFingerprint(receipt.fingerprint, JSON.stringify(['skill-edit', repositoryId, change]));
    return this.requiredMission(receipt.result.id);
  }

  async createSkillMissionWithDispatch(key: string, repositoryId: string, supplied: RepositorySkillChange, authorization: NonNullable<Mission['authorization']>): Promise<Mission> {
    const change = validateRepositorySkillChange(supplied);
    await this.ensureDispatchAlarm(Date.now() + 1000);
    const missionId = crypto.randomUUID();
    const release = this.getSkillEditRequest(key, repositoryId, change) ? undefined : await this.reserveWorkspaceMission(authorization.workspaceId, missionId, repositoryId, 1, missionStepTimeoutMs({ runs: [], skillChange: change }));
    const created = await this.releaseOnFailure(release, () => this.ctx.blockConcurrencyWhile(async () => {
      const existing = this.getSkillEditRequest(key, repositoryId, change);
      if (existing) return existing;
      if (!this.env.GITFLARE_SECURITY) throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'The security service is not configured.');
      const access = securityClient(this.env);
      await access.authorize(authorization.principal, 'contribute', 'repository', repositoryId);
      await access.authorize(authorization.principal, 'execute', 'repository', repositoryId);
      return this.mutate(key, JSON.stringify(['skill-edit', repositoryId, change]), () => {
        const mission = this.newMission(skillMissionInput(repositoryId, change), authorization, undefined, missionId);
        mission.status = 'queued';
        mission.epoch = 1;
        mission.runs = mission.runs.map((run) => ({ ...run, status: 'queued' }));
        this.queueDispatch(mission);
        return this.saveMission(mission, 'Skill edit queued for exact-content execution and repository checks.');
      });
    }));
    if (created.id !== missionId) await release?.();
    return created;
  }

  private ensureDispatchAlarm(...args: Parameters<DispatchBook['ensureDispatchAlarm']>) { return this.dispatches().ensureDispatchAlarm(...args); }

  private queueDispatch(...args: Parameters<DispatchBook['queueDispatch']>) { return this.dispatches().queueDispatch(...args); }

  listDispatches(...args: Parameters<DispatchBook['listDispatches']>) { return this.dispatches().listDispatches(...args); }

  async startMission(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Promise<Mission> {
    await this.ensureDispatchAlarm(Date.now() + 1000);
    const release = await this.reserveMissionCapacity(key, id, authorization);
    const started = await this.releaseOnFailure(release, () => this.mutateMission(key, JSON.stringify(['start', id]), id, () => {
      const mission = pinMissionModels(this.requiredMission(id), models);
      if (!['draft', 'failed', 'cancelled', 'needs_review'].includes(mission.status)) throw new ApiError(409, 'MISSION_ACTIVE', 'Cancel the active attempt or revoke its approval before starting again.');
      const repository = this.getRepository(mission.repositoryId);
      if (mission.skillChange && repository?.headSha !== mission.skillChange.baseSha) throw new ApiError(409, 'STALE_SKILL_BASE', 'The repository changed. Refresh the skill and submit a new edit proposal.');
      if (mission.branchChange?.closedAt) throw new ApiError(409, 'PULL_REQUEST_CLOSED', 'Reopen this pull request before running its checks.');
      if (mission.epoch > 0) this.archive(mission, 'retry');
      if (authorization) mission.authorization = { ...authorization, creatorId: mission.authorization?.creatorId ?? mission.branchChange?.source?.authorId ?? mission.fixRequest?.requesterId ?? authorization.creatorId };
      if (mission.branchChange?.gate) { const { gate: _gate, ...open } = mission.branchChange; mission.branchChange = open; }
      if (mission.fixRequest?.waiting) { const { waiting: _waiting, ...open } = mission.fixRequest; mission.fixRequest = open; }
      mission.status = 'queued';
      mission.epoch += 1;
      mission.baseSha = repository?.headSha ?? null;
      mission.candidateSha = null;
      mission.checks = [];
      mission.changes = [];
      delete mission.error;
      delete mission.approvedAt;
      delete mission.approvedBy;
      delete mission.dependencyApproval;
      delete mission.dependencyChanges;
      delete mission.integrationForkName;
      delete mission.selectedRunId;
      delete mission.raceChecks;
      delete mission.raceChanges;
      mission.runs = mission.runs.map((run) => ({ id: run.id, name: run.name, role: run.role, task: run.task, assignment: run.assignment, model: run.model, modelConfig: run.modelConfig, ...this.pinAgentLimits(run), status: 'queued', changedFiles: [] }));
      this.queueDispatch(mission);
      return this.saveMission(mission, `Execution attempt ${mission.epoch} queued.`);
    }));
    if (started.status === 'cancelled') throw new ApiError(409, 'STALE_REQUEST', 'This start request was cancelled. Use a new request to retry the mission.');
    if (started.status === 'queued') this.queueDispatch(started);
    return started;
  }

  async retryAgents(key: string, id: string, mode: 'retry' | 'drop' | 'review', runIds: string[] | undefined, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections(), guidance?: string, overrides?: Record<string, AgentRetryOverride>): Promise<Mission> {
    await this.ensureDispatchAlarm(Date.now() + 1000);
    const release = await this.reserveMissionCapacity(key, id, authorization);
    const action = mode === 'retry' ? 'retry-agents' : mode === 'review' ? 'address-review' : 'drop-failed-agents';
    const started = await this.releaseOnFailure(release, () => this.mutateMission(key, JSON.stringify([action, id, runIds ? [...runIds].sort() : null, guidance ?? null, ...(overrides ? [overrides] : [])]), id, () => {
      const mission = this.requiredMission(id);
      const reviewing = mode === 'review';
      if (reviewing ? mission.status !== 'needs_review' : !['failed', 'cancelled'].includes(mission.status) || mission.epoch === 0) throw reviewing ? new ApiError(409, 'MISSION_NOT_IN_REVIEW', 'Only a candidate awaiting review can be sent back to its agents.') : new ApiError(409, 'MISSION_NOT_FAILED', 'Only a failed or cancelled attempt can retry or drop individual agents.');
      if (mission.skillChange || mission.revertChange || mission.branchChange) throw new ApiError(409, 'TRUSTED_MISSION', 'This proposal has one trusted editor. Use Retry mission instead.');
      const unknown = (runIds ?? []).filter((runId) => !mission.runs.some((run) => run.id === runId));
      if (unknown.length) throw new ApiError(400, 'UNKNOWN_AGENT', `No agent with ID ${unknown[0]!.slice(0, 64)} belongs to this mission.`);
      if (overrides && mode !== 'retry') throw new ApiError(400, 'INVALID_RETRY_OVERRIDES', 'Overrides apply only to retrying agents.');
      const checks = mission.raceChecks ?? mission.checks;
      const verified = (run: Mission['runs'][number]) => run.status === 'completed' && !!run.commitSha && !!run.forkName && checks.some((check) => check.runId === run.id && check.status === 'passed' && check.candidateSha === run.commitSha);
      const requests = reviewing ? currentReviewRequests(mission) : [];
      if (reviewing && !requests.length && !guidance) throw new ApiError(409, 'NO_CHANGE_REQUESTS', 'This candidate has no open change requests. Request changes first, or pass guidance for the agents.');
      const chosen = reviewing ? runIds ?? (mission.mode === 'race' ? (mission.selectedRunId ? [mission.selectedRunId] : []) : mission.runs.filter(verified).map((run) => run.id)) : runIds;
      if (reviewing && !chosen?.length) throw new ApiError(409, 'SELECT_CANDIDATE', 'Select a candidate first, or name the agents to send the review to.');
      if (reviewing && mission.runs.some((run) => chosen!.includes(run.id) && !verified(run))) throw new ApiError(409, 'AGENT_NOT_VERIFIED', 'Only agents with a verified candidate can address a review.');
      const partReusable = (run: Mission['runs'][number]) => verified(run) && !chosen?.includes(run.id) && !(!reviewing && run.collision);
      const partsReused = mission.runs.every((run) => run.coordinator || run.status === 'skipped' || partReusable(run));
      const reusable = (run: Mission['runs'][number]) => partReusable(run) && (!run.coordinator || mission.mode === 'race' || partsReused);
      const reused = mission.runs.filter(reusable);
      const others = mission.runs.filter((run) => !reusable(run) && (!reviewing || chosen!.includes(run.id)));
      const notRetried = Object.keys(overrides ?? {}).filter((runId) => !others.some((run) => run.id === runId));
      if (notRetried.length) throw new ApiError(409, 'AGENT_NOT_RETRIED', 'Overrides apply only to agents this retry reruns; a verified candidate is reused as is.');
      if (!others.length && (mode === 'drop' || mission.mode === 'race')) throw new ApiError(409, 'NO_FAILED_AGENTS', 'Every agent has a verified candidate. Use Retry mission to rerun them all, or choose the agents to rerun.');
      const sourceOf = (run: Mission['runs'][number]) => ({ runId: run.id, name: run.name, forkName: run.forkName!, commitSha: run.commitSha! });
      const startFrom = (run: Mission['runs'][number]): AgentRun['startFrom'] => {
        if (run.coordinator && mission.mode !== 'race' && !reviewing) return undefined;
        if (reviewing) return { reason: 'review', candidates: (mission.mode === 'race' ? [run] : mission.runs.filter(verified)).map(sourceOf) };
        if (run.collision && reused.length) return { reason: 'collision', files: run.collision.files, candidates: reused.map(sourceOf) };
        if (run.commitSha && run.forkName) return { reason: 'retry', candidates: [sourceOf(run)], ...(run.status !== 'completed' && run.error ? { previousError: failureLine(run.error) } : {}) };
        return run.startFrom;
      };
      const feedback = reviewing ? [requests.length ? `Reviewer change requests on the previous candidate:\n${requests.map((review) => `- ${review.path ? `${review.path}:${review.line} ` : ''}${review.body}`).join('\n')}` : '', guidance ?? ''].filter(Boolean).join('\n\n').slice(0, REVIEW_GUIDANCE_MAX) : guidance;
      const guidanceFor = (run: Mission['runs'][number], from: AgentRun['startFrom']): string | undefined => {
        if (reviewing || !from || from.reason === 'collision' || !run.retryGuidance) return feedback;
        if (!feedback || run.retryGuidance.includes(feedback)) return run.retryGuidance;
        return `${run.retryGuidance}\n\n${feedback}`.slice(0, REVIEW_GUIDANCE_MAX);
      };
      if (mode === 'drop' && !reused.length) throw new ApiError(409, 'NO_COMPLETED_AGENTS', 'No agent has a verified candidate to continue with. Retry the failed agents instead.');
      const repository = this.getRepository(mission.repositoryId);
      const previousEpoch = mission.epoch;
      const previousBase = mission.baseSha;
      this.archive(mission, 'retry');
      if (authorization) mission.authorization = { ...authorization, creatorId: mission.authorization?.creatorId ?? authorization.creatorId };
      const now = new Date().toISOString();
      const reusedIds = new Set(reused.map((run) => run.id));
      const keptChecks = checks.filter((check) => !!check.runId && reusedIds.has(check.runId));
      const keptChanges = (mission.raceChanges ?? mission.changes).filter((change) => change.runIds.some((runId) => reusedIds.has(runId)));
      const fresh = (run: Mission['runs'][number]) => ({ id: run.id, name: run.name, role: run.role, task: run.task, assignment: run.assignment, model: run.model, modelConfig: run.modelConfig, changedFiles: [] as string[], ...(run.coordinator ? { coordinator: true } : {}), ...this.pinAgentLimits(run) });
      mission.runs = mission.runs.map((run) => {
        if (reusedIds.has(run.id)) return { ...run, reusedFromEpoch: run.reusedFromEpoch ?? previousEpoch, ...(run.candidateBaseSha ?? previousBase ? { candidateBaseSha: run.candidateBaseSha ?? previousBase! } : {}) };
        if (mode === 'drop' || reviewing && !chosen!.includes(run.id)) return { ...fresh(run), status: 'skipped' as const, completedAt: now, skipReason: run.skipReason ?? (reviewing ? `Not sent the review in attempt ${previousEpoch + 1}` : `Excluded in attempt ${previousEpoch + 1} after it ${run.status === 'cancelled' ? 'was cancelled' : 'failed'}${run.error ? `: ${failureLine(run.error)}` : ''}`) };
        const [pinned] = pinMissionModels({ ...mission, runs: [withRetryOverride(run, overrides?.[run.id])] }, models).runs;
        const from = startFrom(run);
        const runGuidance = guidanceFor(run, from);
        return { ...fresh(pinned!), status: 'queued' as const, ...(runGuidance ? { retryGuidance: runGuidance } : {}), ...(from ? { startFrom: from } : {}) };
      });
      mission.status = 'queued';
      mission.epoch += 1;
      mission.baseSha = repository?.headSha ?? null;
      mission.candidateSha = null;
      mission.checks = keptChecks;
      mission.changes = keptChanges;
      delete mission.error;
      delete mission.approvedAt;
      delete mission.approvedBy;
      delete mission.dependencyApproval;
      delete mission.dependencyChanges;
      delete mission.integrationForkName;
      delete mission.selectedRunId;
      delete mission.raceChecks;
      delete mission.raceChanges;
      const names = (runs: Mission['runs']) => runs.map((run) => run.name.slice(0, 60)).join(', ');
      const moved = previousBase && mission.baseSha !== previousBase ? ` The default branch moved from ${previousBase.slice(0, 12)} to ${(mission.baseSha ?? 'none').slice(0, 12)}, so ${mission.mode === 'race' ? 'reused candidates will be re-run' : 'reused candidates are merged onto the new base and the combined checks re-verify them'}.` : '';
      const reuseNote = reused.length ? ` Reusing ${reused.length} verified candidate${reused.length === 1 ? '' : 's'} from attempt ${previousEpoch} (${names(reused)}) after confirming each commit is still in its fork.` : '';
      const collided = others.filter((run) => run.collision && reused.length);
      const resumed = reviewing ? [] : others.filter((run) => !(run.collision && reused.length) && ((run.commitSha && run.forkName) || run.startFrom));
      const resumeNote = resumed.length ? ` ${names(resumed)} resume${resumed.length === 1 ? 's' : ''} from ${resumed.length === 1 ? 'its' : 'their'} previous candidate${resumed.length === 1 ? '' : 's'} or starting point instead of the mission base${resumed.some((run) => run.retryGuidance) ? ', keeping earlier change requests and guidance' : ''}.` : '';
      const rebaseNote = collided.length ? ` ${names(collided)} start${collided.length === 1 ? 's' : ''} from the merged candidates of ${names(reused)} to resolve the collision in ${[...new Set(collided.flatMap((run) => run.collision!.files))].slice(0, 10).join(', ')}.` : '';
      const guidanceNote = guidance ? ` Guidance from ${authorization?.principal.userId ?? 'the requester'}: "${guidance.replace(/\s+/g, ' ').slice(0, 300)}${guidance.length > 300 ? '…' : ''}"` : '';
      this.queueDispatch(mission);
      return this.saveMission(mission, mode === 'review'
        ? `Attempt ${mission.epoch} queued to address ${requests.length} change request${requests.length === 1 ? '' : 's'} with ${names(others)}, starting from the reviewed candidate.${reuseNote}${moved}${guidanceNote}`
        : mode === 'retry'
          ? others.length ? `Attempt ${mission.epoch} queued to retry ${others.length} agent${others.length === 1 ? '' : 's'} (${names(others)}).${retryOverrideNote(others, overrides)}${reuseNote}${resumeNote}${rebaseNote}${moved}${guidanceNote}` : `Attempt ${mission.epoch} queued to combine again without rerunning any agent.${reuseNote}${moved}`
          : `Attempt ${mission.epoch} queued without ${others.length} agent${others.length === 1 ? '' : 's'} (${names(others)}), now marked skipped.${reuseNote} Acceptance criteria are unchanged.${moved}`, mode === 'drop' ? 'warning' : 'info');
    }));
    if (started.status === 'queued') this.queueDispatch(started);
    return started;
  }

  async startMissionWithDispatch(key: string, id: string, authorization?: NonNullable<Mission['authorization']>, models = defaultModelConnections()): Promise<Mission> {
    return this.startMission(key, id, authorization, models);
  }

  private watchMission(...args: Parameters<DispatchBook['watchMission']>) { return this.dispatches().watchMission(...args); }

  listMissionWatches(...args: Parameters<DispatchBook['listMissionWatches']>) { return this.dispatches().listMissionWatches(...args); }

  private superviseMissions(...args: Parameters<DispatchBook['superviseMissions']>) { return this.dispatches().superviseMissions(...args); }

  private queueApprovalClear(...args: Parameters<DispatchBook['queueApprovalClear']>) { return this.dispatches().queueApprovalClear(...args); }

  listApprovalClears(...args: Parameters<DispatchBook['listApprovalClears']>) { return this.dispatches().listApprovalClears(...args); }

  settleApprovalClears(...args: Parameters<DispatchBook['settleApprovalClears']>) { return this.dispatches().settleApprovalClears(...args); }

  async alarm(): Promise<void> {
    await this.deliverNotificationDigest().catch(error => console.warn(JSON.stringify({ event: 'notification_digest_failed', message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })));
    await this.prunePreviewCapabilities();
    await this.deliverDispatches();
    await this.superviseMissions();
    await this.settleApprovalClears(undefined, undefined, true);
    const digest = new NotificationBook(this.store).digestAt();
    const next = [...this.listDispatches().map((intent) => intent.nextAttemptAt), ...this.listMissionWatches().map((watch) => watch.checkAt), ...this.listApprovalClears().map((entry) => entry.nextAttemptAt), ...(digest === undefined ? [] : [digest])];
    if (next.length) await this.ensureDispatchAlarm(Math.max(Date.now() + 1000, Math.min(...next)));
  }

  private deliverDispatches(...args: Parameters<DispatchBook['deliverDispatches']>) { return this.dispatches().deliverDispatches(...args); }

  cancelMission(key: string, id: string): Mission {
    return this.mutateMission(key, JSON.stringify(['cancel', id]), id, () => {
      const mission = this.requiredMission(id);
      if (['integrated', 'approved', 'integrating'].includes(mission.status)) throw new ApiError(409, 'MISSION_FINAL', 'An approved or integrating mission cannot be cancelled.');
      mission.status = 'cancelled';
      this.store.delete(`dispatch:${mission.id}-${mission.epoch}`);
      this.store.delete(`watch:${mission.id}-${mission.epoch}`);
      mission.runs = mission.runs.map((run) => ['queued', 'running'].includes(run.status) ? { ...run, status: 'cancelled', completedAt: new Date().toISOString() } : run);
      this.saveMission(mission, 'Mission cancelled. Late execution results will be rejected.', 'warning');
      this.archive(mission, 'cancelled');
      return mission;
    });
  }

  isMissionActive(id: string, epoch: number): boolean {
    const mission = this.getMission(id);
    return !!mission && mission.epoch === epoch && ['queued', 'running', 'checking'].includes(mission.status);
  }

  recordExecution(id: string, epoch: number, result: Partial<ExecutionResult>, complete = false): Mission {
    const mission = this.requiredMission(id);
    assertActiveRun(mission.status, mission.epoch, epoch);
    if (this.store.get(`dispatch:${id}-${epoch}`)) delete mission.error;
    this.store.delete(`dispatch:${id}-${epoch}`);
    this.store.put(`delivered:${id}-${epoch}`, { confirmedAt: new Date().toISOString() });
    if (complete) this.store.delete(`watch:${id}-${epoch}`);
    else this.watchMission(id, epoch);
    if (result.runs) {
      const previousRuns = new Map(mission.runs.map((run) => [run.id, run]));
      for (const run of result.runs) {
        const previous = previousRuns.get(run.id);
        if (!previous || previous.status === run.status && previous.summary === run.summary) continue;
        const summary = run.status === 'failed' && run.error ? failureLine(run.error) : run.summary?.trim().slice(0, 1000);
        mission.events.push({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId: run.id, type: run.status === 'failed' ? 'error' : run.status === 'completed' ? 'success' : run.status === 'cancelled' ? 'warning' : 'info', message: `Attempt ${epoch} · ${run.name.slice(0, 120)}: ${run.status}${summary ? ` — ${summary}` : ''}` });
      }
      mission.runs = result.runs;
    }
    for (const event of result.events ?? []) if (!mission.events.some((existing) => existing.id === event.id)) mission.events.push(event);
    if (result.checks) mission.checks = result.checks;
    if (result.changes) mission.changes = result.changes;
    if (result.candidateSha !== undefined) mission.candidateSha = result.candidateSha;
    if (result.integrationForkName !== undefined) mission.integrationForkName = result.integrationForkName;
    if (result.dependencyChanges?.length) mission.dependencyChanges = result.dependencyChanges;
    else if (result.dependencyChanges) delete mission.dependencyChanges;
    mission.status = 'running';
    if (complete) {
      const durations = checkDurations(mission.checks);
      if (durations.length) this.store.put('check-durations', [...this.getCheckDurations(), ...durations].slice(-DURATION_SAMPLES));
      const race = mission.mode === 'race';
      const passed = race
        ? eligibleRaceRuns(mission).length > 0
        : !!mission.candidateSha && mission.checks.some((check) => check.candidateSha === mission.candidateSha) && mission.checks.every((check) => check.status === 'passed') && mission.runs.every((run) => run.status === 'completed' || run.status === 'skipped') && mission.runs.some((run) => run.status === 'completed');
      mission.status = passed && !result.error ? 'needs_review' : 'failed';
      mission.error = result.error;
      return this.ctx.storage.transactionSync(() => {
        this.saveMission(mission, passed && !result.error ? (race ? `${eligibleRaceRuns(mission).length} candidate(s) passed. Compare them and select one to review.` : 'Candidate checks passed. Review the exact commit before approval.') : 'Execution finished without a passing integration candidate.', passed && !result.error ? 'success' : 'error');
        this.archive(mission, 'completed');
        return mission;
      });
    }
    return this.saveMission(mission);
  }

  reviewMission(key: string, id: string, supplied: ReviewMissionInput, actorId: string, clearFor?: Principal): Mission {
    const input = reviewMissionInput({ ...supplied });
    return this.mutateMission(key, JSON.stringify(['review', id, actorId, input]), id, () => {
      const mission = this.requiredMission(id);
      if (mission.epoch !== input.epoch || mission.candidateSha !== input.candidateSha || mission.baseSha !== input.baseSha) throw new ApiError(409, 'STALE_REVIEW', 'This review belongs to another revision. Refresh the proposal.');
      if (!['needs_review', 'approved'].includes(mission.status)) throw new ApiError(409, 'REVIEW_LOCKED', 'Only a candidate awaiting review or approval can receive a review.');
      mission.reviews ??= [];
      if (input.action === 'resolve') {
        const review = mission.reviews.find((entry) => entry.id === input.reviewId);
        if (!review || review.kind !== 'request_changes' || review.epoch !== input.epoch || review.candidateSha !== input.candidateSha || review.baseSha !== input.baseSha) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'This current revision review could not be found.');
        if (review.authorId !== actorId) throw new ApiError(403, 'REVIEW_AUTHOR_REQUIRED', 'Only the reviewer who requested changes can resolve their request.');
        if (review.resolvedAt) throw new ApiError(409, 'REVIEW_RESOLVED', 'This review request is already resolved.');
        review.resolvedAt = new Date().toISOString();
        review.resolvedBy = actorId;
      } else {
        if (mission.reviews.length >= 500) throw new ApiError(409, 'REVIEW_LIMIT', 'This proposal has reached its discussion limit.');
        assertLineInCandidate(mission, input);
        mission.reviews.push({ id: crypto.randomUUID(), kind: input.action, body: input.body!, authorId: actorId, createdAt: new Date().toISOString(), epoch: input.epoch, candidateSha: input.candidateSha, baseSha: input.baseSha, ...(input.summary ? { summary: true } : {}), ...(input.path === undefined ? {} : { path: input.path, line: input.line, side: input.side }) });
        if (input.action === 'request_changes') this.queueApprovalClear(id, clearFor);
        if (input.action === 'request_changes' && mission.status === 'approved') {
          this.archive(mission, 'approved');
          mission.status = 'needs_review';
          delete mission.approvedAt;
          delete mission.approvedBy;
          delete mission.dependencyApproval;
          this.archive(mission, 'approval_revoked');
        }
      }
      return this.saveMission(mission, input.action === 'resolve' ? `Reviewer ${actorId} resolved their change request.` : input.action === 'request_changes' ? `Reviewer ${actorId} requested changes to this revision.` : input.action === 'approve' ? `Reviewer ${actorId} approved this revision.` : input.path === undefined ? `${actorId} added a review comment.` : `${actorId} commented on ${input.path.slice(0, 200)}:${input.line}.`, input.action === 'request_changes' ? 'warning' : 'info');
    });
  }

  selectCandidate(key: string, id: string, runId: string, epoch: number, actorId = 'workspace-owner', clearFor?: Principal): Mission {
    return this.mutateMission(key, JSON.stringify(['select', id, runId, epoch]), id, () => {
      const mission = this.requiredMission(id);
      if (mission.mode !== 'race') throw new ApiError(409, 'NOT_A_RACE', 'Only a race mission has candidates to choose between.');
      if (mission.epoch !== epoch) throw new ApiError(409, 'STALE_SELECTION', 'This selection belongs to another attempt. Refresh the mission.');
      if (mission.status !== 'needs_review') throw new ApiError(409, 'SELECTION_LOCKED', 'A candidate can be selected only while the race awaits review. Revoke approval to choose again.');
      const run = eligibleRaceRuns(mission).find((entry) => entry.id === runId);
      if (!run) throw new ApiError(409, 'CANDIDATE_NOT_ELIGIBLE', 'Select an agent whose candidate passed its checks.');
      mission.raceChecks ??= mission.checks;
      mission.raceChanges ??= mission.changes;
      this.queueApprovalClear(id, clearFor);
      mission.selectedRunId = run.id;
      mission.candidateSha = run.commitSha!;
      mission.integrationForkName = run.forkName;
      mission.checks = mission.raceChecks.filter((check) => check.runId === run.id);
      mission.changes = mission.raceChanges.filter((change) => change.runIds.includes(run.id));
      if (run.dependencyChanges?.length) mission.dependencyChanges = run.dependencyChanges;
      else delete mission.dependencyChanges;
      return this.saveMission(mission, `${actorId} selected ${run.name.slice(0, 120)}'s candidate ${run.commitSha!.slice(0, 12)} for review.`);
    });
  }

  approveMission(key: string, id: string, candidateSha: string, baseSha: string, actorId = 'workspace-owner', dependencyApprover = false, commitMessage?: string): Mission {
    return this.mutateMission(key, JSON.stringify(['approve', id, candidateSha, baseSha, ...(commitMessage === undefined ? [] : [commitMessage])]), id, () => {
      const mission = this.requiredMission(id);
      const repository = this.getRepository(mission.repositoryId);
      assertReviewClear(mission);
      assertApproval({ status: mission.status, candidateSha: mission.candidateSha, baseSha: mission.baseSha, currentHead: repository?.headSha, requestedCandidate: candidateSha, requestedBase: baseSha, checksPassed: mission.checks.some((check) => check.candidateSha === mission.candidateSha) && mission.checks.every((check) => check.status === 'passed') });
      assertDependencyApprover(mission, dependencyApprover);
      mission.status = 'approved';
      mission.approvedAt = new Date().toISOString();
      mission.approvedBy = actorId;
      if (mission.dependencyChanges?.length) mission.dependencyApproval = { approvedBy: actorId, approvedAt: mission.approvedAt, candidateSha, baseSha, epoch: mission.epoch };
      if (commitMessage !== undefined) mission.landingMessage = { message: commitMessage, candidateSha, baseSha, epoch: mission.epoch, setBy: actorId, setAt: mission.approvedAt };
      this.saveMission(mission, `Reviewer ${actorId} approved commit ${candidateSha.slice(0, 12)}. Approval does not merge or deploy this change.`, 'success');
      this.archive(mission, 'approved');
      return mission;
    });
  }

  setLandingMessage(id: string, candidateSha: string, baseSha: string, message: string, actorId: string): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      if (!['needs_review', 'approved'].includes(mission.status)) throw new ApiError(409, 'LANDING_MESSAGE_LOCKED', 'The commit message can change only before landing starts.');
      if (mission.candidateSha !== candidateSha || mission.baseSha !== baseSha) throw new ApiError(409, 'STALE_APPROVAL', 'Refresh before setting the commit message for this exact candidate and base.');
      if (activeLandingMessage(mission) === message) return mission;
      mission.landingMessage = { message, candidateSha, baseSha, epoch: mission.epoch, setBy: actorId, setAt: new Date().toISOString() };
      return this.saveMission(mission, `${actorId} set the commit message for landing.`);
    });
  }

  revokeApproval(key: string, id: string, candidateSha: string, baseSha: string, clearFor?: Principal): Mission {
    return this.mutateMission(key, JSON.stringify(['revoke', id, candidateSha, baseSha]), id, () => {
      const mission = this.requiredMission(id);
      if (mission.status !== 'approved') throw new ApiError(409, 'NOT_APPROVED', 'Only an approved mission can have its approval revoked. Resolve any integration first.');
      if (mission.candidateSha !== candidateSha || mission.baseSha !== baseSha) throw new ApiError(409, 'STALE_APPROVAL', 'Refresh before revoking approval for this exact candidate and base.');
      this.queueApprovalClear(id, clearFor);
      this.archive(mission, 'approved');
      mission.status = 'needs_review';
      delete mission.approvedAt;
      delete mission.approvedBy;
      delete mission.dependencyApproval;
      this.saveMission(mission, 'Approval was revoked. Review this candidate again or rerun the mission against the current branch.', 'warning');
      this.archive(mission, 'approval_revoked');
      return mission;
    });
  }

  beginIntegration(...args: Parameters<IntegrationBook['beginIntegration']>) { return this.integrations().beginIntegration(...args); }

  completeIntegration(...args: Parameters<IntegrationBook['completeIntegration']>) { return this.integrations().completeIntegration(...args); }

  contributorStanding(userId: string): ContributorStanding | null { return this.store.get<ContributorStanding>(`contributor:${userId}`) ?? null; }

  private recordContributorLanding(mission: Mission): void {
    const source = mission.branchChange?.source;
    if (!source) return;
    const vouch = this.store.get<Principal>(`vouch:${mission.id}`);
    this.store.delete(`vouch:${mission.id}`);
    const current = this.contributorStanding(source.authorId);
    this.store.put(`contributor:${source.authorId}`, { userId: source.authorId, landed: (current?.landed ?? 0) + 1, firstProposalAt: current?.firstProposalAt ?? mission.createdAt, ...(vouch ? { vouchedBy: vouch } : current?.vouchedBy ? { vouchedBy: current.vouchedBy } : {}) } satisfies ContributorStanding);
  }

  holdOutsideProposal(id: string, gate: OutsideChecksGate): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      if (!mission.branchChange?.source || mission.branchChange.closedAt || ['queued', 'running', 'checking', 'integrating', 'integrated'].includes(mission.status)) return mission;
      if (mission.epoch > 0 && mission.status !== 'draft') this.archive(mission, 'retry');
      mission.branchChange = { ...mission.branchChange, gate };
      mission.status = 'draft';
      mission.candidateSha = null;
      mission.checks = [];
      mission.changes = [];
      delete mission.error;
      delete mission.approvedAt;
      delete mission.approvedBy;
      delete mission.dependencyApproval;
      delete mission.integrationForkName;
      return this.saveMission(mission, 'Waiting for a maintainer to run checks.');
    });
  }

  recordOutgoingProposal(entry: OutgoingProposal): void { this.store.put(`outgoing:${entry.missionId}`, entry); }

  outgoingProposal(missionId: string): OutgoingProposal | null { return this.store.get<OutgoingProposal>(`outgoing:${missionId}`) ?? null; }

  listOutgoingProposals(): OutgoingProposal[] { return this.store.list<OutgoingProposal>('outgoing:').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  private recordLinkedIssues(mission: Mission, sha: string): void {
    if (mission.issueNumber !== undefined) recordIssueOutcome(this.store, mission.issueNumber, 'closed', `Closed by mission ${mission.title} (${sha.slice(0, 7)}).`);
    const reverted = mission.revertChange ? this.getMission(mission.revertChange.missionId) : undefined;
    if (reverted?.issueNumber !== undefined) recordIssueOutcome(this.store, reverted.issueNumber, 'open', `Reopened because mission ${reverted.title} was reverted (${sha.slice(0, 7)}).`);
  }

  claimIntegrationPush(...args: Parameters<IntegrationBook['claimIntegrationPush']>) { return this.integrations().claimIntegrationPush(...args); }

  releaseStaleIntegration(...args: Parameters<IntegrationBook['releaseStaleIntegration']>) { return this.integrations().releaseStaleIntegration(...args); }

  retryIntegration(...args: Parameters<IntegrationBook['retryIntegration']>) { return this.integrations().retryIntegration(...args); }

  integrationFailed(...args: Parameters<IntegrationBook['integrationFailed']>) { return this.integrations().integrationFailed(...args); }

  integrationClaim(...args: Parameters<IntegrationBook['integrationClaim']>) { return this.integrations().integrationClaim(...args); }

  private releaseOnFailure<T>(release: (() => Promise<void>) | undefined, operation: () => T | Promise<T>): Promise<T> { return this.capacity().releaseOnFailure(release, operation); }

  private reserveMissionCapacity(...args: Parameters<CapacityBook['reserveMissionCapacity']>) { return this.capacity().reserveMissionCapacity(...args); }
  private reserveWorkspaceMission(...args: Parameters<CapacityBook['reserveWorkspaceMission']>) { return this.capacity().reserveWorkspaceMission(...args); }

  reserveMissionSlot(...args: Parameters<CapacityBook['reserveMissionSlot']>) { return this.capacity().reserveMissionSlot(...args); }

  releaseMissionSlot(...args: Parameters<CapacityBook['releaseMissionSlot']>) { return this.capacity().releaseMissionSlot(...args); }

  reservePreviewSlot(...args: Parameters<CapacityBook['reservePreviewSlot']>) { return this.capacity().reservePreviewSlot(...args); }

  holdPreviewSlot(...args: Parameters<CapacityBook['holdPreviewSlot']>) { return this.capacity().holdPreviewSlot(...args); }

  releasePreviewSlot(...args: Parameters<CapacityBook['releasePreviewSlot']>) { return this.capacity().releasePreviewSlot(...args); }

  previewSlotHolders() { return this.capacity().previewSlotHolders(); }

  deployState(): DeployState { return new DeploymentLedger(this.store).state(); }

  githubMirror(): StoredMirror | null { return this.store.get<StoredMirror>('github-mirror') ?? null; }

  changeGithubMirror(change: MirrorChange): MirrorChangeResult { return this.ctx.storage.transactionSync(() => applyMirrorChange(this.store, change)); }

  githubImport(): StoredImport | null { return this.store.get<StoredImport>('github-import') ?? null; }

  changeGithubImport(change: ImportChange): ImportChangeResult { return this.ctx.storage.transactionSync(() => applyImportChange(this.store, change)); }

  importedGithubPulls(source: string, numbers: number[]): Record<number, string> { return importedPullMissions(this.store, source, numbers); }

  importedGithubReleases(source: string, ids: number[]): number[] { return importedReleaseIds(this.store, source, ids); }

  githubOrgImports(): OrgImportRecord[] { return this.store.list<OrgImportRecord>('github-org-import:').sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  githubOrgImport(id: string): OrgImportRecord | null { return this.store.get<OrgImportRecord>(`github-org-import:${id}`) ?? null; }

  githubOrgImportRequest(requestId: string): OrgImportRecord | null { return this.githubOrgImports().find(record => record.requestId === requestId) ?? null; }

  saveGithubOrgImport(record: OrgImportRecord): void {
    this.ctx.storage.transactionSync(() => {
      this.store.put(`github-org-import:${record.id}`, record);
      for (const stale of this.githubOrgImports().slice(ORG_IMPORTS_KEPT)) this.store.delete(`github-org-import:${stale.id}`);
    });
  }

  githubImportRegistry(): ImportRegistryEntry[] { return this.store.list<ImportRegistryEntry>('github-import-entry:'); }

  registerGithubImport(entry: ImportRegistryEntry, enabled: boolean): void {
    if (enabled) this.store.put(`github-import-entry:${entry.repositoryId}`, entry); else this.store.delete(`github-import-entry:${entry.repositoryId}`);
  }

  secretLinks(): SecretLink[] { return new SecretLinkBook(this.store).links(); }

  secretReceipt(key: string): SecretReceipt | null { return new SecretLinkBook(this.store).receipt(key); }

  saveSecretLink(link: SecretLink, receipt?: { key: string; value: SecretReceipt }): SecretLink {
    return this.ctx.storage.transactionSync(() => new SecretLinkBook(this.store).save(link, receipt));
  }

  removeSecretLink(environment: string, binding: string, receipt?: { key: string; value: SecretReceipt }): SecretLink | null {
    return this.ctx.storage.transactionSync(() => new SecretLinkBook(this.store).remove(environment, binding, receipt));
  }

  recordSecretRequest(key: string, value: SecretReceipt): void { new SecretLinkBook(this.store).record(key, value); }

  saveDeploySettings(settings: DeploySettings): DeploySettings { return new DeploymentLedger(this.store).saveSettings(settings); }

  saveDeployEnvironment(environment: DeployEnvironment, settings: DeployEnvironmentSettings): DeploySettings {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).saveEnvironment(environment, settings));
  }

  saveDetectedDeploySetup(environments: Partial<Record<DeployEnvironment, DeployEnvironmentSettings>>, detected: SavedDetection): DeploySettings {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).saveDetected(environments, detected));
  }

  getDeployment(id: string): DeploymentRecord | undefined { return new DeploymentLedger(this.store).get(id); }

  createDeployment(key: string, fingerprint: string, record: DeploymentRecord): DeploymentRecord {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).create(key, fingerprint, record));
  }

  confirmDeployment(id: string, actorId: string): DeploymentRecord {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).confirm(id, actorId));
  }

  updateDeployment(id: string, expected: DeploymentStatus[], patch: Partial<DeploymentRecord>): DeploymentRecord | null {
    return this.ctx.storage.transactionSync(() => new DeploymentLedger(this.store).update(id, expected, patch));
  }

  deployAccess(): DeployAccessRecord[] { return new DeployAccessBook(this.store).list(); }

  deployAccessReceipt(key: string, fingerprint: string): DeployAccessResult | null {
    const receipt = this.store.get<Receipt<DeployAccessResult>>(`request:${key}`);
    if (!receipt) return null;
    assertReplayFingerprint(receipt.fingerprint, fingerprint);
    return receipt.result;
  }

  saveDeployAccess(key: string, fingerprint: string, environment: DeployEnvironment, record: DeployAccessRecord | null, result: DeployAccessResult): DeployAccessResult {
    return this.mutate(key, fingerprint, () => { new DeployAccessBook(this.store).save(environment, record); return result; });
  }
}

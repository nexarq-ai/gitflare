import type { Mission, MissionAttempt, MissionEvent } from '../shared/types';
import { assertActiveRun } from './domain';
import type { AppEnv } from './env';
import type { SqlStore } from './store';
import { securityClient, type Principal } from './security';
import { missionStepTimeoutMs } from './budgets';
import { type DispatchIntent, DISPATCH_FAST_ATTEMPTS, type MissionWatch, MISSION_WATCHDOG_MS, WATCHDOG_MISSING_LIMIT, WATCHDOG_MISSING_RECHECK_MS, ACTIVE_WORKFLOW, TERMINAL_WORKFLOW, type ApprovalClear, APPROVAL_CLEAR_RETRY_MS, APPROVAL_CLEAR_MAX_BACKOFF_MS, type CoordinatorHost } from './coordinator-types';

export class DispatchBook {
  private readonly ctx: DurableObjectState;
  private readonly env: AppEnv;

  constructor(private readonly host: CoordinatorHost) {
    this.ctx = host.ctx;
    this.env = host.env;
  }

  private get store(): SqlStore { return this.host.store; }

  private requiredMission(id: string): Mission { return this.host.requiredMission(id); }
  private saveMission(mission: Mission, message?: string, type?: MissionEvent['type']): Mission { return this.host.saveMission(mission, message, type); }
  private archive(mission: Mission, reason: MissionAttempt['reason']): void { return this.host.archive(mission, reason); }
  private isMissionActive(id: string, epoch: number): boolean { return this.host.isMissionActive(id, epoch); }

  async ensureDispatchAlarm(when: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > when) await this.ctx.storage.setAlarm(when);
  }

  queueDispatch(mission: Mission): void {
    const workflowId = `${mission.id}-${mission.epoch}`;
    if (!this.store.get(`dispatch:${workflowId}`) && !this.store.get(`delivered:${workflowId}`)) this.store.put(`dispatch:${workflowId}`, { workflowId, missionId: mission.id, repositoryId: mission.repositoryId, epoch: mission.epoch, attempts: 0, nextAttemptAt: Date.now() } satisfies DispatchIntent);
  }

  listDispatches(): DispatchIntent[] {
    return this.store.list<DispatchIntent>('dispatch:');
  }

  private failDispatch(id: string, epoch: number, error = 'The Workflow ended before mission completion was recorded. Start a new attempt to retry; late results from this attempt will be rejected.', runError = 'Workflow dispatch was not confirmed'): Mission {
    return this.ctx.storage.transactionSync(() => {
      const mission = this.requiredMission(id);
      assertActiveRun(mission.status, mission.epoch, epoch);
      mission.status = 'failed';
      mission.error = error;
      mission.runs = mission.runs.map((run) => ['queued', 'running'].includes(run.status) ? { ...run, status: 'failed', completedAt: new Date().toISOString(), error: runError } : run);
      this.store.delete(`dispatch:${id}-${epoch}`);
      this.store.delete(`watch:${id}-${epoch}`);
      this.saveMission(mission, mission.error, 'error');
      this.archive(mission, 'completed');
      return mission;
    });
  }

  private watchdogMs(): number {
    const seconds = Number(this.env?.MISSION_WATCHDOG_SECONDS);
    return Number.isFinite(seconds) && seconds >= 60 ? seconds * 1000 : MISSION_WATCHDOG_MS;
  }

  watchMission(id: string, epoch: number): void {
    const key = `watch:${id}-${epoch}`;
    const now = Date.now();
    const existing = this.store.get<MissionWatch>(key);
    this.store.put(key, { workflowId: `${id}-${epoch}`, missionId: id, epoch, deliveredAt: existing?.deliveredAt ?? now, lastReportAt: now, checkAt: now + this.watchdogMs(), misses: 0 } satisfies MissionWatch);
  }

  listMissionWatches(): MissionWatch[] {
    return this.store.list<MissionWatch>('watch:');
  }

  async superviseMissions(): Promise<void> {
    const due = this.listMissionWatches().filter((watch) => watch.checkAt <= Date.now()).slice(0, 10);
    for (const watch of due) {
      const key = `watch:${watch.workflowId}`;
      if (!this.isMissionActive(watch.missionId, watch.epoch)) { this.store.delete(key); continue; }
      let status: string | null = null;
      try { status = (await (await this.env.MISSION_WORKFLOW!.get(watch.workflowId)).status()).status; } catch {}
      const current = this.store.get<MissionWatch>(key);
      if (!current || current.lastReportAt !== watch.lastReportAt || !this.isMissionActive(watch.missionId, watch.epoch)) continue;
      const mission = this.requiredMission(watch.missionId);
      const budgetMs = missionStepTimeoutMs(mission) + this.watchdogMs();
      const silentMinutes = Math.max(1, Math.round((Date.now() - watch.lastReportAt) / 60_000));
      const misses = status ? 0 : watch.misses + 1;
      const reason = status && TERMINAL_WORKFLOW.includes(status) ? `The Workflow for attempt ${watch.epoch} ${status === 'complete' ? 'completed' : `ended as ${status}`} without reporting a result (no report for ${silentMinutes} min)`
        : misses >= WATCHDOG_MISSING_LIMIT ? `The Workflow for attempt ${watch.epoch} could not be found after ${misses} checks (no report for ${silentMinutes} min)`
        : Date.now() - watch.deliveredAt > budgetMs ? `Attempt ${watch.epoch} exceeded its ${Math.round(budgetMs / 60_000)}-minute execution budget without a final report`
        : null;
      if (reason) {
        console.error(JSON.stringify({ event: 'mission_watchdog_failed', missionId: watch.missionId, epoch: watch.epoch, workflowStatus: status, misses }));
        this.failDispatch(watch.missionId, watch.epoch, `${reason}. Start a new attempt to retry; late results from this attempt will be rejected.`, 'Execution stopped without reporting a result');
        continue;
      }
      this.store.put(key, { ...watch, misses, checkAt: Date.now() + (status && ACTIVE_WORKFLOW.includes(status) ? this.watchdogMs() : WATCHDOG_MISSING_RECHECK_MS) } satisfies MissionWatch);
    }
  }

  queueApprovalClear(missionId: string, principal?: Principal): void {
    if (!principal) return;
    this.store.put(`approval-clear:${missionId}`, { missionId, principal, queuedAt: new Date().toISOString(), attempts: 0, nextAttemptAt: Date.now() } satisfies ApprovalClear);
  }

  listApprovalClears(): ApprovalClear[] {
    return this.store.list<ApprovalClear>('approval-clear:');
  }

  async settleApprovalClears(missionId?: string, actor?: Principal, dueOnly = false): Promise<void> {
    const pending = this.listApprovalClears().filter((entry) => (!missionId || entry.missionId === missionId) && (!dueOnly || entry.nextAttemptAt <= Date.now()));
    if (!pending.length) return;
    await this.ensureDispatchAlarm(Date.now() + APPROVAL_CLEAR_RETRY_MS);
    let failure: unknown;
    for (const entry of pending) {
      const key = `approval-clear:${entry.missionId}`;
      try {
        await securityClient(this.env).clearApprovals(actor ?? entry.principal, entry.missionId);
        if (this.store.get<ApprovalClear>(key)?.queuedAt === entry.queuedAt) this.store.delete(key);
      } catch (error) {
        failure ??= error;
        const attempts = entry.attempts + 1;
        console.error(JSON.stringify({ event: 'approval_clear_failed', missionId: entry.missionId, attempts }));
        if (this.store.get<ApprovalClear>(key)?.queuedAt === entry.queuedAt) this.store.put(key, { ...entry, attempts, nextAttemptAt: Date.now() + Math.min(APPROVAL_CLEAR_MAX_BACKOFF_MS, APPROVAL_CLEAR_RETRY_MS * 2 ** (attempts - 1)) } satisfies ApprovalClear);
      }
    }
    if (failure && !dueOnly) throw failure;
  }

  async deliverDispatches(): Promise<void> {
    const existing = this.listDispatches();
    if (!existing.length) return;
    const due = existing.filter((intent) => intent.nextAttemptAt <= Date.now()).slice(0, 10);
    if (!due.length) {
      await this.ensureDispatchAlarm(Math.min(...existing.map((intent) => intent.nextAttemptAt)));
      return;
    }
    await this.ensureDispatchAlarm(Date.now() + 60_000);
    for (const intent of due) {
      const key = `dispatch:${intent.workflowId}`;
      if (!this.isMissionActive(intent.missionId, intent.epoch)) {
        this.store.delete(key);
        continue;
      }
      let confirmed = false;
      let terminal = false;
      try {
        if (!this.env.MISSION_WORKFLOW) throw new Error('Workflow binding unavailable');
        await this.env.MISSION_WORKFLOW.create({ id: intent.workflowId, params: { repositoryId: intent.repositoryId, missionId: intent.missionId, epoch: intent.epoch } });
        confirmed = true;
      } catch {
        try {
          const status = await (await this.env.MISSION_WORKFLOW!.get(intent.workflowId)).status();
          confirmed = ['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(status.status);
          terminal = ['complete', 'errored', 'terminated'].includes(status.status);
        } catch {}
      }
      if (!this.store.get(key)) continue;
      if (!this.isMissionActive(intent.missionId, intent.epoch)) {
        this.store.delete(key);
        continue;
      }
      if (confirmed) {
        this.ctx.storage.transactionSync(() => {
          this.store.delete(key);
          this.store.put(`delivered:${intent.workflowId}`, { confirmedAt: new Date().toISOString() });
          this.watchMission(intent.missionId, intent.epoch);
          const mission = this.requiredMission(intent.missionId);
          delete mission.error;
          this.saveMission(mission, `Workflow dispatch confirmed for attempt ${intent.epoch}.`);
        });
        continue;
      }
      const attempts = intent.attempts + 1;
      if (terminal) {
        this.failDispatch(intent.missionId, intent.epoch);
        continue;
      }
      this.ctx.storage.transactionSync(() => {
        this.store.put(key, { ...intent, attempts, nextAttemptAt: Date.now() + (attempts >= DISPATCH_FAST_ATTEMPTS ? 300_000 : Math.min(60_000, 1000 * 2 ** attempts)) });
        const mission = this.requiredMission(intent.missionId);
        mission.error = `Workflow dispatch is awaiting confirmation after ${attempts} attempts. Automatic retries use the same Workflow ID. Cancel this attempt to reject any late execution.`;
        this.saveMission(mission, mission.error, 'warning');
      });
    }
  }
}

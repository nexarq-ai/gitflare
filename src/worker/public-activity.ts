import type { ActivityTotals, ActivityWeek, AgentReadiness, AgentReadyLevel, AgentReadySignal, Issue, MissionSummary, Release } from '../shared/types';
import { ISSUE_TEMPLATE_DIRECTORIES } from './issue-templates';
import { skillRoots } from './repository-skills';
import { SECURITY_POLICY_FILES } from './security-policy';

export const ACTIVITY_WEEKS = 26;
const WEEK_MS = 7 * 86_400_000;
const README = /^readme(?:\.(?:md|markdown|txt))?$/i;
const LICENSE = /^(?:licen[cs]e|copying)(?:[.-][a-z0-9.-]{1,20})?$/i;
const SKILL_FILE = /(?:^|\/)SKILL\.md$/;

export function weekStart(value: string | number): string {
  const date = new Date(value);
  const day = (date.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day)).toISOString().slice(0, 10);
}

export function emptyTotals(): ActivityTotals { return { people: 0, agents: 0, missions: 0, reviews: 0, releases: 0, issues: 0 }; }

export function activityWindow(now: number, weeks = ACTIVITY_WEEKS): string[] {
  const latest = Date.parse(weekStart(now));
  return Array.from({ length: weeks }, (_, index) => new Date(latest - (weeks - 1 - index) * WEEK_MS).toISOString().slice(0, 10));
}

export function landedBy(mission: Pick<MissionSummary, 'runs' | 'branchChange' | 'revertChange' | 'skillChange'>): 'agents' | 'people' {
  return mission.runs.some(run => run.status === 'completed') && !mission.branchChange && !mission.revertChange && !mission.skillChange ? 'agents' : 'people';
}

export function activityWeeks(input: { missions: MissionSummary[]; releases: Release[]; issues: Pick<Issue, 'createdAt'>[]; now: number }): ActivityWeek[] {
  const window = activityWindow(input.now);
  const rows = new Map(window.map(week => [week, { week, ...emptyTotals() }]));
  const bucket = (value: string | undefined) => value && !Number.isNaN(Date.parse(value)) ? rows.get(weekStart(value)) : undefined;
  for (const mission of input.missions) {
    if (mission.status === 'integrated') { const row = bucket(mission.updatedAt); if (row) row[landedBy(mission)]++; }
    if (mission.status !== 'draft' && mission.runs.some(run => run.status !== 'draft')) { const row = bucket(mission.createdAt); if (row) row.missions++; }
    if (mission.reviewCount) { const row = bucket(mission.updatedAt); if (row) row.reviews += mission.reviewCount; }
  }
  for (const release of input.releases) if (!release.draft && release.publishedAt) { const row = bucket(release.publishedAt); if (row) row.releases++; }
  for (const issue of input.issues) { const row = bucket(issue.createdAt); if (row) row.issues++; }
  return [...rows.values()];
}

export function sumWeeks(groups: ActivityWeek[][], now: number): { weeks: ActivityWeek[]; totals: ActivityTotals } {
  const window = activityWindow(now);
  const weeks = window.map(week => ({ week, ...emptyTotals() }));
  for (const group of groups) for (const row of group) {
    const target = weeks.find(item => item.week === row.week);
    if (!target) continue;
    for (const key of Object.keys(emptyTotals()) as (keyof ActivityTotals)[]) target[key] += row[key];
  }
  const totals = emptyTotals();
  for (const row of weeks) for (const key of Object.keys(totals) as (keyof ActivityTotals)[]) totals[key] += row[key];
  return { weeks, totals };
}

interface SignalRule { id: string; label: string; weight: number; hint: string; present(paths: string[], files: Record<string, string | null>): boolean }

const hasTestScript = (raw: string | null, key: 'test' | 'scripts'): boolean => {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = key === 'test' ? parsed.test : (parsed.scripts as Record<string, unknown> | undefined)?.test;
    return typeof value === 'string' && value.trim().length > 0;
  } catch { return false; }
};

export const READINESS_RULES: SignalRule[] = [
  { id: 'rules', label: 'Agent rules', weight: 25, hint: 'Add AGENTS.md so agents follow your conventions.', present: paths => paths.some(path => /^(?:AGENTS|CLAUDE)\.md$/i.test(path)) },
  { id: 'checks', label: 'Checks', weight: 20, hint: 'Add a test command in gitflare.json or a test script in package.json so every candidate is checked.', present: (paths, files) => hasTestScript(files['gitflare.json'] ?? null, 'test') || hasTestScript(files['package.json'] ?? null, 'scripts') },
  { id: 'skills', label: 'Skills', weight: 15, hint: 'Add a SKILL.md under .agents/skills to give agents project know-how.', present: paths => paths.some(path => SKILL_FILE.test(path) && skillRoots.some(root => path.startsWith(`${root}/`))) },
  { id: 'readme', label: 'README', weight: 10, hint: 'Add a README so agents and people know what the project does.', present: paths => paths.some(path => README.test(path)) },
  { id: 'license', label: 'License', weight: 10, hint: 'Add a LICENSE so others know how they may use the code.', present: paths => paths.some(path => LICENSE.test(path)) },
  { id: 'codeowners', label: 'Code owners', weight: 5, hint: 'Add .gitflare/CODEOWNERS so the right reviewer is asked.', present: paths => paths.includes('.gitflare/CODEOWNERS') },
  { id: 'templates', label: 'Issue templates', weight: 5, hint: 'Add issue templates under .gitflare/ISSUE_TEMPLATE so reports arrive complete.', present: paths => paths.some(path => ISSUE_TEMPLATE_DIRECTORIES.some(directory => path.startsWith(`${directory}/`))) },
  { id: 'security', label: 'Security policy', weight: 5, hint: 'Add SECURITY.md so vulnerabilities are reported privately.', present: paths => paths.some(path => (SECURITY_POLICY_FILES as readonly string[]).includes(path)) },
  { id: 'contributing', label: 'Contributing guide', weight: 5, hint: 'Add CONTRIBUTING.md so outside proposals follow your process.', present: paths => paths.some(path => /^(?:\.gitflare\/|\.github\/|docs\/)?CONTRIBUTING\.md$/i.test(path)) },
];

export const READINESS_FILES = ['gitflare.json', 'package.json'] as const;

export function readinessLevel(score: number): AgentReadyLevel { return score >= 70 ? 'ready' : score >= 35 ? 'partial' : 'none'; }

export function agentReadiness(paths: string[], files: Record<string, string | null>): AgentReadiness {
  const signals: AgentReadySignal[] = READINESS_RULES.map(rule => ({ id: rule.id, label: rule.label, present: rule.present(paths, files), hint: rule.hint, weight: rule.weight }));
  const score = signals.reduce((total, signal) => total + (signal.present ? signal.weight : 0), 0);
  return { score, level: readinessLevel(score), signals };
}

export function parseReadiness(score: number | null | undefined, signals: string | null | undefined): AgentReadiness | null {
  if (score === null || score === undefined) return null;
  let parsed: AgentReadySignal[] = [];
  try { parsed = JSON.parse(signals ?? '[]') as AgentReadySignal[]; } catch { parsed = []; }
  return { score, level: readinessLevel(score), signals: parsed };
}

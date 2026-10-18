import type { Mission } from './types';

export const COMMIT_SUBJECT_MAX = 200;
export const COMMIT_MESSAGE_MAX = 10_000;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function normalizeCommitMessage(subject: string, body = ''): string {
  const clean = (text: string) => text.replace(/\r\n?/g, '\n').replace(CONTROL, '').split('\n').map(line => line.trimEnd()).join('\n');
  const head = clean(subject).replace(/\s+/g, ' ').trim();
  const rest = clean(body).replace(/^\n+|\n+$/g, '');
  return rest ? `${head}\n\n${rest}` : head;
}

export function splitCommitMessage(message: string): { subject: string; body: string } {
  const [subject = '', ...rest] = message.replace(/\r\n?/g, '\n').split('\n');
  return { subject, body: rest.join('\n').replace(/^\n+/, '') };
}

export function commitMessageProblem(message: string): string | null {
  const { subject } = splitCommitMessage(message);
  if (!subject.trim()) return 'Write a commit subject line.';
  if (subject.length > COMMIT_SUBJECT_MAX) return `Keep the commit subject to ${COMMIT_SUBJECT_MAX} characters or fewer.`;
  if (message.length > COMMIT_MESSAGE_MAX) return `Keep the commit message to ${COMMIT_MESSAGE_MAX.toLocaleString('en-US')} characters or fewer.`;
  return null;
}

export function missionTrailer(missionId: string): string {
  return `Gitflare mission ${missionId}`;
}

export function withMissionTrailer(message: string, missionId: string): string {
  const trailer = missionTrailer(missionId);
  return message.split('\n').some(line => line.trim() === trailer) ? message : `${message}\n\n${trailer}`;
}

export function activeLandingMessage(mission: Partial<Pick<Mission, 'landingMessage' | 'candidateSha' | 'baseSha' | 'epoch'>>): string | undefined {
  const pending = mission.landingMessage;
  return pending && pending.candidateSha === mission.candidateSha && pending.baseSha === mission.baseSha && pending.epoch === mission.epoch ? pending.message : undefined;
}

type SuggestionSource = Pick<Mission, 'title' | 'changes' | 'runs' | 'mode' | 'selectedRunId'> & Partial<Pick<Mission, 'landingMessage' | 'candidateSha' | 'baseSha' | 'epoch'>>;

const FILE_LIMIT = 8;
const SUMMARY_LIMIT = 300;

export function suggestedCommitMessage(mission: SuggestionSource): { subject: string; body: string } {
  const pending = activeLandingMessage(mission);
  if (pending) return splitCommitMessage(pending);
  const subject = mission.title.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, COMMIT_SUBJECT_MAX);
  const runs = mission.runs.filter(run => run.status === 'completed' && (mission.mode !== 'race' || run.id === mission.selectedRunId));
  const summaries = runs.flatMap(run => {
    const summary = (run.summary ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
    return summary && run.changedFiles?.length ? [`- ${run.name}: ${summary.length > SUMMARY_LIMIT ? `${summary.slice(0, SUMMARY_LIMIT - 1)}…` : summary}`] : [];
  });
  const paths = mission.changes.map(change => change.path);
  const files = paths.length ? `Changed ${paths.length === 1 ? 'file' : 'files'}: ${paths.slice(0, FILE_LIMIT).join(', ')}${paths.length > FILE_LIMIT ? ` and ${paths.length - FILE_LIMIT} more` : ''}` : '';
  const agents = runs.length ? `Agents: ${runs.map(run => `${run.name} (${run.role})`).join(', ')}` : '';
  return { subject, body: [summaries.join('\n'), files, agents].filter(Boolean).join('\n\n') };
}

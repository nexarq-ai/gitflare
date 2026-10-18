export type MirrorRefState = 'pending' | 'synced' | 'failed' | 'diverged';
export interface MirrorError { code: string; message: string }

export interface MirrorRefStatus {
  ref: string;
  state: MirrorRefState;
  gitflareSha: string | null;
  githubSha: string | null;
  lastSyncedSha: string | null;
  lastSyncedAt?: string;
  error?: MirrorError;
  importedBranch?: string;
  updatedAt: string;
}

export type MirrorSyncState = 'idle' | 'running' | 'retrying' | 'failed';

export interface MirrorSyncStatus {
  state: MirrorSyncState;
  reason?: string;
  attempt?: number;
  lastRunAt?: string;
  lastSuccessAt?: string;
  error?: MirrorError;
}

export interface MirrorCredentialStatus { kind: 'pat' | 'app'; installationId?: number; setBy: string; setAt: string }

export interface GitHubMirrorView {
  owner: string;
  name: string;
  url: string;
  refPatterns: string[];
  credential: MirrorCredentialStatus | null;
  linkedBy: string;
  linkedAt: string;
  updatedAt: string;
  adoptedAt?: string;
  sync: MirrorSyncStatus;
  refs: MirrorRefStatus[];
  diverged: boolean;
}

export interface GitHubMirrorSnapshot {
  repositoryId: string;
  canManage: boolean;
  defaultRefPatterns: string[];
  app: { available: boolean; installUrl?: string };
  mirror: GitHubMirrorView | null;
}

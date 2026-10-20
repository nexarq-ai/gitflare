export type GitHubImportPhase = 'labels' | 'issues' | 'comments' | 'pulls' | 'releases' | 'done';
export type GitHubImportState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'canceled';
export type GitHubImportMode = 'full' | 'pull';
export type GitHubImportCredentialKind = 'none' | 'token' | 'mirror';

export interface GitHubImportOptions { issues: boolean; pullRequests: boolean; releases: boolean }
export interface GitHubImportCounts { labels: number; issues: number; pullRequests: number; proposals: number; comments: number; releases: number; updated: number; skipped: number }
export interface GitHubImportSkip { kind: 'label' | 'issue' | 'comment' | 'pull' | 'release'; ref: string; reason: string }
export interface GitHubImportError { code: string; message: string }

export interface GitHubImportTransition { enabled: boolean; lastPullAt?: string; lastError?: GitHubImportError }
export interface GitHubImportCanonical { at: string; by: string; noticeUrl?: string; noticeError?: string }

export interface GitHubImportView {
  id: string;
  owner: string;
  name: string;
  url: string;
  options: GitHubImportOptions;
  mode: GitHubImportMode;
  state: GitHubImportState;
  phase: GitHubImportPhase;
  counts: GitHubImportCounts;
  skipped: GitHubImportSkip[];
  preserveNumbers: boolean;
  sourcePrivate: boolean;
  credential: GitHubImportCredentialKind;
  keepCredential: boolean;
  requestedBy: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  retryAt?: string;
  error?: GitHubImportError;
  transition: GitHubImportTransition;
  canonical?: GitHubImportCanonical;
}

export interface GitHubImportSnapshot {
  repositoryId: string;
  canManage: boolean;
  job: GitHubImportView | null;
  mirror: { owner: string; name: string; credential: boolean } | null;
}

export interface GitHubOrgRepository { name: string; fullName: string; description: string; private: boolean; archived: boolean; fork: boolean; defaultBranch: string; openIssues: number; pushedAt: string | null; url: string }
export interface GitHubOrgListing { owner: string; repositories: GitHubOrgRepository[]; nextPage: number | null }

export interface GitHubOrgImportEntry { name: string; repositoryId: string | null; error?: GitHubImportError; code?: { status: string; phase: string }; data?: { state: GitHubImportState; phase: GitHubImportPhase; counts: GitHubImportCounts } }
export interface GitHubOrgImportView { id: string; owner: string; createdAt: string; createdBy: string; options: GitHubImportOptions; repositories: GitHubOrgImportEntry[] }

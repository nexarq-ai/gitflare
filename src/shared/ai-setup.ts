import { publicRepositoryPath } from './handles';

export const REQUEST_CHANGE_PARAM = 'change';
export const PERSONAL_WORKSPACE_PARAM = 'workspace';
export const RETURN_PARAM = 'return';

export function safeReturnPath(value: string | null | undefined): string | null {
  if (!value || value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || /[\\\s]/.test(value)) return null;
  return value;
}

export function requestChangePath(handle: string, repository: string): string {
  return `${publicRepositoryPath(handle, repository)}?${REQUEST_CHANGE_PARAM}=1`;
}

export function aiSetupPath(back: string, handleRequired: boolean): string {
  const models = `/settings/models?${new URLSearchParams({ [PERSONAL_WORKSPACE_PARAM]: 'personal', [RETURN_PARAM]: back })}`;
  return handleRequired ? `/account/profile?${new URLSearchParams({ [RETURN_PARAM]: models })}` : models;
}

export function requestedPersonalWorkspace(search: string, userId: string, workspaces: { id: string }[]): string | null {
  if (new URLSearchParams(search).get(PERSONAL_WORKSPACE_PARAM) !== 'personal') return null;
  return workspaces.find(item => item.id === `personal-${userId}`)?.id ?? null;
}

export function returnPathFrom(search: string): string | null {
  return safeReturnPath(new URLSearchParams(search).get(RETURN_PARAM));
}

export const SECRET_ACTIONS = ['link', 'create', 'rotate', 'update', 'validate', 'unlink', 'create-store'] as const;
export type SecretAction = typeof SECRET_ACTIONS[number];

export const PREVIEW_SECRET_ENVIRONMENT = 'preview';
export const SECRET_VALUE_MAX_BYTES = 65_536;
export const SECRET_BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const SECRET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
export const STORE_ID_PATTERN = /^[a-f0-9]{32}$/;

export type SecretValidationStatus = 'valid' | 'not_found' | 'not_workers_scoped' | 'unchecked';

export interface SecretLinkView {
  id: string;
  environment: string;
  binding: string;
  accountId: string;
  storeId: string;
  secretId: string;
  secretName: string;
  previewAllowed: boolean;
  consumers: string[];
  origin: 'linked' | 'created';
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  rotatedAt?: string;
  rotatedBy?: string;
  rotationCount: number;
  validation: { status: SecretValidationStatus; checkedAt: string; detail?: string };
}

export interface SecretRequirementView {
  environment: string;
  binding: string;
  source: 'secrets_store_secrets' | 'secrets.required';
  configPath: string;
  workerName: string;
  declared?: { storeId?: string; secretName?: string };
  linkId: string | null;
}

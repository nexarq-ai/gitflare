type LogValue = string | number | boolean | null | undefined | readonly string[];

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,60}$/;

export function errorFields(error: unknown): { errorName: string; errorCode?: string } {
  const errorName = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : 'UnknownError';
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
  return typeof code === 'string' && SAFE_NAME.test(code) ? { errorName, errorCode: code } : { errorName };
}

// Error messages are left out: provider and storage errors can echo tokens, emails or request bodies
export function logFailure(event: string, error: unknown, fields: Record<string, LogValue> = {}, level: 'error' | 'warn' = 'error'): void {
  console[level](JSON.stringify({ event, ...fields, ...errorFields(error) }));
}
